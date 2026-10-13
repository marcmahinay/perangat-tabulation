'use strict';

// Pure tabulation maths. Nothing in this file touches the database or the
// network, so every rule here can be unit tested in isolation.

function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

const round2 = (value) => roundTo(value, 2);
const sum = (values) => values.reduce((total, value) => total + value, 0);

/**
 * Standard competition ranking ("1-2-2-4"): tied entries share a rank and the
 * following rank is skipped. Returns a Map of entry -> rank.
 */
function rankEntries(entries, compare) {
  const sorted = [...entries].sort(compare);
  const ranks = new Map();
  let current = 0;
  sorted.forEach((entry, index) => {
    if (index === 0 || compare(sorted[index - 1], entry) !== 0) current = index + 1;
    ranks.set(entry, current);
  });
  return ranks;
}

/**
 * Works out how many points a recorded violation costs.
 * Timed rules are charged from the measured time; everything else is charged
 * `quantity` times (default once).
 */
function computeDeductionCharge(type, { measuredSeconds = null, quantity = null } = {}) {
  let units;
  if (type.limit_seconds != null && measuredSeconds != null) {
    const excess = measuredSeconds - type.limit_seconds;
    if (excess <= 0) units = 0;
    else if (type.unit === 'per_minute') units = Math.floor(excess / 60);
    else if (type.unit === 'per_started_minute') units = Math.ceil(excess / 60);
    else units = 1;
  } else {
    units = quantity == null ? 1 : quantity;
  }
  return { quantity: units, points: round2(units * type.points) };
}

/**
 * Tabulates one category.
 *
 *   judge total  = sum of criterion scores - "per judge" deductions
 *   judge rank   = that judge's ranking of the contingents by judge total
 *   average      = mean of the totals of every judge who finished the contingent
 *   final score  = average - "final score" deductions
 *
 * ranking_method 'rank_sum' (the Perangat rule): the contingent with the lowest
 * sum of judge ranks wins; the average score only breaks ties.
 * ranking_method 'average': the highest final score wins.
 *
 * `judges` carry their scoresheet `status`; the category is final once every
 * assigned judge has submitted.
 */
function computeCategoryResults({ category, criteria, contestants, judges, scores, deductions }) {
  const scoreByCell = new Map();
  for (const score of scores) {
    scoreByCell.set(`${score.judge_id}:${score.contestant_id}:${score.criterion_id}`, score.score);
  }

  const byRankSum = category.ranking_method === 'rank_sum';

  const deductionsByContestant = new Map();
  if (category.apply_deductions) {
    for (const deduction of deductions) {
      if (!deductionsByContestant.has(deduction.contestant_id)) deductionsByContestant.set(deduction.contestant_id, []);
      deductionsByContestant.get(deduction.contestant_id).push(deduction);
    }
  }

  const rows = contestants.map((contestant) => {
    // When the judges' ranks decide the result, a deduction "from the final
    // score" would change nothing if it were taken off afterwards. It can only
    // count by coming off every judge's total before the judges are ranked.
    const applied = (deductionsByContestant.get(contestant.id) || [])
      .map((deduction) => (byRankSum ? { ...deduction, scope: 'per_judge' } : deduction));
    const perJudgeDeduction = round2(sum(applied.filter((d) => d.scope === 'per_judge').map((d) => d.points)));
    const finalDeduction = round2(sum(applied.filter((d) => d.scope === 'final').map((d) => d.points)));

    const byJudge = {};
    for (const judge of judges) {
      const cells = {};
      let raw = 0;
      for (const criterion of criteria) {
        const value = scoreByCell.get(`${judge.id}:${contestant.id}:${criterion.id}`);
        if (value != null) {
          cells[criterion.id] = value;
          raw += value;
        }
      }
      const filled = Object.keys(cells).length;
      const complete = criteria.length > 0 && filled === criteria.length;
      byJudge[judge.id] = {
        scores: cells,
        filled,
        complete,
        raw: round2(raw),
        deduction: perJudgeDeduction,
        net: complete ? round2(Math.max(0, raw - perJudgeDeduction)) : null,
        rank: null,
      };
    }

    return {
      contestant: { id: contestant.id, contestant_no: contestant.contestant_no, name: contestant.name },
      judges: byJudge,
      deductions: applied.map((d) => ({ name: d.name, scope: d.scope, points: d.points, remarks: d.remarks })),
      perJudgeDeduction,
      finalDeduction,
    };
  });

  // Each judge's own ranking of the contingents they have fully scored.
  for (const judge of judges) {
    const entries = rows.map((row) => row.judges[judge.id]).filter((entry) => entry.complete);
    for (const [entry, rank] of rankEntries(entries, (a, b) => b.net - a.net)) entry.rank = rank;
  }

  for (const row of rows) {
    const finished = judges.map((judge) => row.judges[judge.id]).filter((entry) => entry.complete);
    row.judgesComplete = finished.length;
    row.complete = judges.length > 0 && finished.length === judges.length;
    // Six decimals: enough to keep genuinely different averages apart, while
    // still erasing floating point noise before values are compared.
    row.average = finished.length ? roundTo(sum(finished.map((entry) => entry.net)) / finished.length, 6) : null;
    row.final = row.average == null ? null : roundTo(Math.max(0, row.average - row.finalDeduction), 6);
    row.rankSum = row.complete ? sum(finished.map((entry) => entry.rank)) : null;
    row.rank = null;
    row.placement = null;
  }

  const compare = byRankSum
    ? (a, b) => a.rankSum - b.rankSum || b.final - a.final
    : (a, b) => b.final - a.final;
  const rankable = rows.filter((row) => (byRankSum ? row.rankSum != null : row.final != null));
  const titles = category.placement_titles || [];
  for (const [row, rank] of rankEntries(rankable, compare)) {
    row.rank = rank;
    row.placement = titles[rank - 1] || null;
  }

  return {
    category: {
      id: category.id,
      name: category.name,
      apply_deductions: category.apply_deductions,
      ranking_method: category.ranking_method,
      placement_titles: titles,
    },
    maxScore: round2(sum(criteria.map((criterion) => criterion.weight))),
    criteria: criteria.map(({ id, name, description, weight }) => ({ id, name, description, weight })),
    judges: judges.map((judge) => ({
      id: judge.id,
      judge_no: judge.judge_no,
      name: judge.name,
      status: judge.status || 'draft',
      submitted_at: judge.submitted_at || null,
      completed: rows.filter((row) => row.judges[judge.id].complete).length,
      total: rows.length,
    })),
    rows,
    isFinal: judges.length > 0 && rows.length > 0 && judges.every((judge) => judge.status === 'submitted'),
  };
}

module.exports = { computeCategoryResults, computeDeductionCharge, rankEntries, roundTo, round2 };
