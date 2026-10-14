// Wording for ties: how each tie in a category was settled, and the rules that
// settle them. The results screen and the printed sheets both use this, so they
// always say the same thing.

import { fmt, plain } from '/shared/dom.js';

/** ['A', 'B', 'C'] -> "A, B and C" */
function list(items) {
  return items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Averages are compared to six decimals but normally shown to three. When three
 * would make different averages look the same, show as many as it takes.
 */
function averagePlaces(rows) {
  const distinct = new Set(rows.map((row) => row.average)).size;
  for (let places = 3; places < 6; places += 1) {
    if (new Set(rows.map((row) => fmt(row.average, places))).size === distinct) return places;
  }
  return 6;
}

/**
 * The rows of each tie, in placing order. `levels` are the rows the tie-break
 * could not separate: either decided by one vote of the judges, or still
 * sharing a rank while they wait for it.
 */
function tieGroups(result) {
  const rowById = new Map(result.rows.map((row) => [row.contestant.id, row]));
  return result.ties.map((tie) => {
    const rows = tie.contestantIds.map((id) => rowById.get(id));
    const byLevel = new Map();
    for (const row of rows) {
      const key = row.vote ? `vote ${row.vote.id}` : `rank ${row.rank}`;
      byLevel.set(key, [...(byLevel.get(key) || []), row]);
    }
    return { tie, rows, places: averagePlaces(rows), levels: [...byLevel.values()].filter((level) => level.length > 1) };
  });
}

const award = (titles, rank) => (titles[rank - 1] ? ` (${titles[rank - 1]})` : '');

/** How a level was settled: "the judges voted: A (rank 3), B (rank 4)", or the shared rank while it waits. */
function settled(level, titles) {
  if (level[0].vote) {
    const order = level.map((row) => `${row.contestant.name} (rank ${row.rank}${titles[row.rank - 1] ? `, ${titles[row.rank - 1]}` : ''})`).join(', ');
    const note = level[0].vote.note ? ` (${level[0].vote.note})` : '';
    return `the judges voted${note}: ${order}`;
  }
  const { rank } = level[0];
  return `they share rank ${rank}${award(titles, rank)} until the judges vote to separate them`;
}

/** One sentence per tie in the category, saying who was level and how it was settled. */
export function tieNotes(result) {
  const titles = result.category.placement_titles;
  const names = (rows) => list(rows.map((row) => row.contestant.name));

  return tieGroups(result).map(({ tie, rows, places, levels }) => {
    if (tie.basis === 'average') {
      return `${names(rows)} are tied on an average score of ${fmt(tie.value, 3)}, so ${settled(rows, titles)}.`;
    }

    const tied = `${names(rows)} are tied on a rank total of ${plain(tie.value)}`;
    if (levels.length === 1 && levels[0].length === rows.length) {
      return `${tied} and on an average score of ${fmt(rows[0].average, 3)}, so ${settled(rows, titles)}.`;
    }
    const order = rows.map((row) => `${row.contestant.name} ${fmt(row.average, places)} (rank ${row.rank})`).join(', ');
    const level = levels.map((group) => ` ${names(group)} are level on average score too, so ${settled(group, titles)}.`);
    return `${tied}. The higher average score is placed first: ${order}.${level.join('')}`;
  });
}

/**
 * A short remark for each tied contingent's row, keyed by contingent id: a
 * `label`, and the `detail` that decided its place.
 */
export function tieRemarks(result) {
  const remarks = new Map();
  for (const { tie, rows, places, levels } of tieGroups(result)) {
    const level = new Set(levels.flat());
    for (const row of rows) {
      if (row.vote) remarks.set(row.contestant.id, { label: "Judges' vote", detail: row.vote.note });
      else if (level.has(row)) remarks.set(row.contestant.id, { label: `Tied for rank ${row.rank}`, detail: 'judges to vote' });
      else if (tie.basis === 'rank_sum') {
        remarks.set(row.contestant.id, { label: 'Tie-break', detail: `avg. score ${fmt(row.average, places)}` });
      }
    }
  }
  return remarks;
}

/** The tie-break rules for the category's ranking method, in the order they are applied. */
export function tieGuidelines(result) {
  const vote = 'are placed by a majority vote of the judges. If the vote is level, the chairman of the board of judges decides.';
  const recorded = 'Averages count as the same only when they are equal to six decimal places. The tabulator records the result of any vote, and the results sheet shows each placing that was decided by vote.';
  if (result.category.ranking_method !== 'rank_sum') {
    return [`Contingents with the same average score ${vote}`, recorded];
  }
  return [
    "On one judge's sheet, contingents with the same final score share the average of the places they cover: two level for 2nd and 3rd get rank 2.5 each, and the next gets rank 4. They are not separated further.",
    "Contingents with the same rank total are placed by average score, the mean of every judge's final score for the contingent (raw score less deductions). The higher average is placed first.",
    `Contingents with the same rank total and the same average score ${vote}`,
    recorded,
  ];
}

/** One sentence per set of equal scores on a judge's own sheet, explaining the shared rank. */
export function judgeTieNotes(result, judgeId) {
  const label = result.category.apply_deductions ? 'final score' : 'total score';
  const byRank = new Map();
  for (const row of result.rows) {
    const entry = row.judges[judgeId];
    if (entry.rank != null) byRank.set(entry.rank, [...(byRank.get(entry.rank) || []), row]);
  }
  return [...byRank.entries()]
    .filter(([, rows]) => rows.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([rank, rows]) => {
      // A fractional rank is the middle of the places the tie covers.
      const first = rank - (rows.length - 1) / 2;
      const last = rank + (rows.length - 1) / 2;
      const covered = rows.length === 2 ? `places ${first} and ${last}` : `places ${first} to ${last}`;
      return `${list(rows.map((row) => row.contestant.name))} have the same ${label} (${fmt(rows[0].judges[judgeId].net)}), `
        + `so they share ${covered}: rank ${rank} each.`;
    });
}
