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
 * Ranks entries in the order given by `compare`. Returns a Map of entry -> rank.
 *
 * Tied entries are handled one of two ways:
 *  - fractional ("1 - 2.5 - 2.5 - 4"): each takes the average of the places the
 *    tie covers. The ranks on a sheet then always add up to the same total, so
 *    a judge who ties contingents gives out exactly as many rank points as one
 *    who does not.
 *  - shared, the default ("1 - 2 - 2 - 4"): each takes the best place of the
 *    tie and the places after it are skipped. Used for final placings.
 */
function rankEntries(entries, compare, { fractional = false } = {}) {
  const sorted = [...entries].sort(compare);
  const ranks = new Map();
  let first = 0;
  while (first < sorted.length) {
    let last = first;
    while (last + 1 < sorted.length && compare(sorted[first], sorted[last + 1]) === 0) last += 1;
    // The tie covers places first + 1 through last + 1.
    const rank = fractional ? (first + last + 2) / 2 : first + 1;
    for (let index = first; index <= last; index += 1) ranks.set(sorted[index], rank);
    first = last + 1;
  }
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
 * Finds the contingents that are level on the figure a category is decided by
 * (`key` is 'rankSum' or 'average'), so the results can say how each tie was
 * settled. Each tie lists its contingents in placing order; the ones that the
 * tie-break could not separate have the same `rank`.
 */
function findTies(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row[key])) groups.set(row[key], []);
    groups.get(row[key]).push(row);
  }
  return [...groups.entries()]
    .filter(([, tied]) => tied.length > 1)
    .map(([value, tied]) => ({
      basis: key === 'rankSum' ? 'rank_sum' : 'average',
      value,
      contestantIds: [...tied]
        .sort((a, b) => a.rank - b.rank || a.contestant.contestant_no - b.contestant.contestant_no)
        .map((row) => row.contestant.id),
    }))
    .sort((a, b) => (key === 'rankSum' ? a.value - b.value : b.value - a.value));
}

/**
 * Tabulates one category.
 *
 *   raw score    = sum of a judge's criterion scores for a contingent
 *   final score  = raw score - every deduction charged to that contingent
 *   judge rank   = that judge's ranking of the contingents by final score;
 *                  equal scores share the average of their places (fractional ranking)
 *   average      = mean of the final scores of every judge who finished the contingent
 *
 * Every deduction comes off each judge's raw score. There is no other place a
 * deduction is applied.
 *
 * ranking_method 'rank_sum' (the Perangat rule): the contingent with the lowest
 * sum of judge ranks wins; the average score only breaks ties.
 * ranking_method 'average': the highest average score wins.
 *
 * `ties` reports every group of contingents level on the rank total (or, with
 * 'average', on the average score), whether or not the tie-break separated them.
 * Contingents the tie-break cannot separate are placed by the judges' vote:
 * `tieVotes` are the recorded votes ({ id, contestantIds, placing, note }),
 * `votes` the ones that apply, and `pendingVotes` the levels still waiting for one.
 *
 * `judges` carry their scoresheet `status`; the category is final once every
 * assigned judge has submitted.
 */
function computeCategoryResults({ category, criteria, contestants, judges, scores, deductions, tieVotes = [] }) {
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
    const applied = deductionsByContestant.get(contestant.id) || [];
    const deduction = round2(sum(applied.map((entry) => entry.points)));

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
        deduction,
        net: complete ? round2(Math.max(0, raw - deduction)) : null,
        rank: null,
      };
    }

    return {
      contestant: { id: contestant.id, contestant_no: contestant.contestant_no, name: contestant.name },
      judges: byJudge,
      deductions: applied.map((entry) => ({ name: entry.name, points: entry.points, remarks: entry.remarks })),
      deduction,
    };
  });

  // Each judge's own ranking of the contingents they have fully scored. Equal
  // totals get a fractional rank, so these may be halves (2.5) as well as whole numbers.
  for (const judge of judges) {
    const entries = rows.map((row) => row.judges[judge.id]).filter((entry) => entry.complete);
    const ranks = rankEntries(entries, (a, b) => b.net - a.net, { fractional: true });
    for (const [entry, rank] of ranks) entry.rank = rank;
  }

  for (const row of rows) {
    const finished = judges.map((judge) => row.judges[judge.id]).filter((entry) => entry.complete);
    row.judgesComplete = finished.length;
    row.complete = judges.length > 0 && finished.length === judges.length;
    // Six decimals: enough to keep genuinely different averages apart, while
    // still erasing floating point noise before values are compared.
    row.average = finished.length ? roundTo(sum(finished.map((entry) => entry.net)) / finished.length, 6) : null;
    row.rankSum = row.complete ? sum(finished.map((entry) => entry.rank)) : null;
    row.rank = null;
    row.placement = null;
    row.vote = null;
    row.awaitingVote = false;
  }

  const compare = byRankSum
    ? (a, b) => a.rankSum - b.rankSum || b.average - a.average
    : (a, b) => b.average - a.average;
  const rankable = rows.filter((row) => (byRankSum ? row.rankSum != null : row.average != null));
  const titles = category.placement_titles || [];
  // Final placings are whole numbers so that each maps to an award title.
  const levels = new Map();
  for (const [row, rank] of rankEntries(rankable, compare)) {
    row.rank = rank;
    row.vote = null;
    row.awaitingVote = false;
    if (!levels.has(rank)) levels.set(rank, []);
    levels.get(rank).push(row);
  }

  // Contingents still level after the tie-break are placed by the judges' vote. A
  // recorded vote counts only for exactly the contingents it was taken for: if the
  // scores change and the tie is no longer the same, it no longer applies.
  const voteFor = new Map(tieVotes.map((vote) => [[...vote.contestantIds].sort((a, b) => a - b).join(','), vote]));
  const votes = [];
  const pendingVotes = [];
  for (const [rank, level] of levels) {
    if (level.length < 2) continue;
    const ids = level.map((row) => row.contestant.id).sort((a, b) => a - b);
    const vote = voteFor.get(ids.join(','));
    if (vote) {
      const byId = new Map(level.map((row) => [row.contestant.id, row]));
      vote.placing.forEach((id, index) => {
        const row = byId.get(id);
        row.rank = rank + index;
        row.vote = { id: vote.id, note: vote.note || '' };
      });
      votes.push({ id: vote.id, rank, contestantIds: [...vote.placing], note: vote.note || '' });
    } else {
      for (const row of level) row.awaitingVote = true;
      pendingVotes.push({ rank, contestantIds: level.map((row) => row.contestant.id) });
    }
  }
  for (const row of rankable) row.placement = titles[row.rank - 1] || null;

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
    ties: findTies(rankable, byRankSum ? 'rankSum' : 'average'),
    votes,
    pendingVotes,
    isFinal: judges.length > 0 && rows.length > 0 && judges.every((judge) => judge.status === 'submitted'),
  };
}

module.exports = { computeCategoryResults, computeDeductionCharge, rankEntries, roundTo, round2 };
