'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeCategoryResults, computeDeductionCharge, rankEntries } = require('../src/server/scoring');
const { CATEGORIES, DEDUCTION_TYPES } = require('../src/server/seed');

const typeNamed = (name) => DEDUCTION_TYPES.find((type) => type.name === name);

function category(overrides = {}) {
  return {
    id: 1,
    name: 'Dance Showdown',
    apply_deductions: 1,
    ranking_method: 'average',
    placement_titles: ['CHAMPION', '1ST RUNNER UP'],
    ...overrides,
  };
}

const criteria = [
  { id: 1, name: 'Performance', description: '', weight: 35 },
  { id: 2, name: 'Creativity', description: '', weight: 25 },
  { id: 3, name: 'Costume', description: '', weight: 20 },
  { id: 4, name: 'Music', description: '', weight: 20 },
];

/** Builds score rows from { judgeId: { contestantId: [c1, c2, c3, c4] } }. */
function scoreRows(table) {
  const rows = [];
  for (const [judgeId, byContestant] of Object.entries(table)) {
    for (const [contestantId, values] of Object.entries(byContestant)) {
      values.forEach((score, index) => {
        if (score != null) {
          rows.push({ judge_id: Number(judgeId), contestant_id: Number(contestantId), criterion_id: index + 1, score });
        }
      });
    }
  }
  return rows;
}

const judges = (count, status = 'draft') =>
  Array.from({ length: count }, (_, index) => ({ id: index + 1, judge_no: index + 1, name: `Judge ${index + 1}`, status }));

const contestants = (names) => names.map((name, index) => ({ id: index + 1, contestant_no: index + 1, name }));

test('seeded criteria weights total 100% in every category', () => {
  for (const seeded of CATEGORIES) {
    const total = seeded.criteria.reduce((sum, [, weight]) => sum + weight, 0);
    assert.equal(total, 100, seeded.name);
  }
});

test('rankEntries shares a rank between ties and skips the next one', () => {
  const entries = [{ v: 93 }, { v: 91 }, { v: 91 }, { v: 91 }, { v: 85 }];
  const ranks = rankEntries(entries, (a, b) => b.v - a.v);
  assert.deepEqual(entries.map((entry) => ranks.get(entry)), [1, 2, 2, 2, 5]);
});

test('fractional ranking gives ties the average of the places they cover', () => {
  const ranked = (values) => {
    const entries = values.map((v) => ({ v }));
    const ranks = rankEntries(entries, (a, b) => b.v - a.v, { fractional: true });
    return entries.map((entry) => ranks.get(entry));
  };
  assert.deepEqual(ranked([93, 91, 91, 85]), [1, 2.5, 2.5, 4]);       // 2nd and 3rd -> 2.5 each
  assert.deepEqual(ranked([93, 91, 91, 91, 85]), [1, 3, 3, 3, 5]);    // 2nd, 3rd and 4th -> 3 each
  assert.deepEqual(ranked([90, 90, 80, 80]), [1.5, 1.5, 3.5, 3.5]);
  assert.deepEqual(ranked([88, 88, 88, 88]), [2.5, 2.5, 2.5, 2.5]);
  assert.deepEqual(ranked([70, 95, 80]), [3, 1, 2]);                  // no ties: ordinary ranks
});

test('a judge who ties contingents gives out the same rank points as one who does not', () => {
  // Judge 1 separates all five. Judge 2 ties three of them. Judge 3 ties everyone.
  const result = computeCategoryResults({
    category: category({ ranking_method: 'rank_sum' }),
    criteria: [{ id: 1, name: 'Overall', description: '', weight: 100 }],
    contestants: contestants(['A', 'B', 'C', 'D', 'E']),
    judges: judges(3),
    scores: [
      [95, 94, 93, 92, 91],
      [95, 90, 90, 90, 85],
      [90, 90, 90, 90, 90],
    ].flatMap((sheet, judge) => sheet.map((score, index) => (
      { judge_id: judge + 1, contestant_id: index + 1, criterion_id: 1, score }
    ))),
    deductions: [],
  });

  const column = (judgeId) => result.rows.map((row) => row.judges[judgeId].rank);
  assert.deepEqual(column(1), [1, 2, 3, 4, 5]);
  assert.deepEqual(column(2), [1, 3, 3, 3, 5]);
  assert.deepEqual(column(3), [3, 3, 3, 3, 3]);
  // 1 + 2 + 3 + 4 + 5 = 15 on every sheet, however many ties it has.
  for (const judgeId of [1, 2, 3]) assert.equal(column(judgeId).reduce((a, b) => a + b, 0), 15);
  assert.deepEqual(result.rows.map((row) => row.rankSum), [5, 8, 9, 10, 13]);
  assert.deepEqual(result.rows.map((row) => row.rank), [1, 2, 3, 4, 5]);
});

test('entrance and exit overtime is one flat point for any excess', () => {
  const entrance = typeNamed('Exceeding Entrance Time');
  assert.equal(computeDeductionCharge(entrance, { measuredSeconds: 240 }).points, 0);
  assert.equal(computeDeductionCharge(entrance, { measuredSeconds: 241 }).points, 1);
  assert.equal(computeDeductionCharge(entrance, { measuredSeconds: 400 }).points, 1);

  const exit = typeNamed('Exceeding Exit Time');
  assert.equal(computeDeductionCharge(exit, { measuredSeconds: 120 }).points, 0);
  assert.equal(computeDeductionCharge(exit, { measuredSeconds: 121 }).points, 1);
});

test('performance overtime is free up to 5:59 and one point per minute from 6:00', () => {
  const performance = typeNamed('Exceeding Actual Performance Time');
  const points = (seconds) => computeDeductionCharge(performance, { measuredSeconds: seconds }).points;
  assert.equal(points(300), 0);
  assert.equal(points(359), 0);
  assert.equal(points(360), 1);
  assert.equal(points(419), 1);
  assert.equal(points(420), 2);
});

test('untimed violations are charged per occurrence', () => {
  const safety = typeNamed('Safety & Prohibited Acts Violation');
  assert.deepEqual(computeDeductionCharge(safety), { quantity: 1, points: 5 });
  assert.deepEqual(computeDeductionCharge(safety, { quantity: 2 }), { quantity: 2, points: 10 });
});

test('a judge total is the sum of criterion scores, as on the 2025 scoresheet', () => {
  const result = computeCategoryResults({
    category: category(),
    criteria,
    contestants: contestants(['Surigao City', 'Dipolog City']),
    judges: judges(1),
    scores: scoreRows({ 1: { 1: [32.5, 22.5, 18, 18], 2: [31, 20, 17, 16] } }),
    deductions: [{ contestant_id: 2, points: 1, name: 'Exceeding Actual Performance Time', remarks: '' }],
  });

  const [surigao, dipolog] = result.rows;
  assert.equal(result.maxScore, 100);
  assert.equal(surigao.judges[1].raw, 91);
  assert.equal(surigao.judges[1].net, 91);
  assert.equal(surigao.judges[1].rank, 1);
  assert.equal(dipolog.judges[1].raw, 84);
  assert.equal(dipolog.judges[1].deduction, 1);
  assert.equal(dipolog.judges[1].net, 83);
  assert.equal(dipolog.judges[1].rank, 2);
});

test('every deduction comes off each judge\'s raw score', () => {
  const input = {
    criteria,
    contestants: contestants(['A', 'B']),
    judges: judges(3, 'submitted'),
    scores: scoreRows({
      1: { 1: [30, 20, 18, 18], 2: [30, 20, 15, 15] },
      2: { 1: [32, 22, 18, 18], 2: [30, 20, 15, 15] },
      3: { 1: [31, 21, 18, 18], 2: [30, 20, 15, 15] },
    }),
    // A time penalty and a safety penalty: 1 + 5 = 6 off every judge's raw score for A.
    deductions: [
      { contestant_id: 1, points: 1, name: 'Exceeding Entrance Time', remarks: '' },
      { contestant_id: 1, points: 5, name: 'Safety & Prohibited Acts Violation', remarks: '' },
    ],
  };

  for (const method of ['rank_sum', 'average']) {
    const result = computeCategoryResults({ ...input, category: category({ ranking_method: method }) });
    const [a, b] = result.rows;
    assert.deepEqual(Object.values(a.judges).map((entry) => entry.raw), [86, 90, 88], method);
    assert.deepEqual(Object.values(a.judges).map((entry) => entry.deduction), [6, 6, 6], method);
    assert.deepEqual(Object.values(a.judges).map((entry) => entry.net), [80, 84, 82], method);
    assert.equal(a.deduction, 6, method);
    assert.equal(a.average, 82, method);
    // B has no deductions: raw and final are the same.
    assert.deepEqual(Object.values(b.judges).map((entry) => [entry.raw, entry.deduction, entry.net]),
      [[80, 0, 80], [80, 0, 80], [80, 0, 80]], method);
    assert.equal(b.average, 80, method);
    assert.equal(a.placement, 'CHAMPION', method);
    assert.equal(b.placement, '1ST RUNNER UP', method);
    assert.equal(result.isFinal, true, method);
  }
});

test('a deduction is taken off before the judges are ranked, so it can change the ranks', () => {
  const input = {
    category: category({ ranking_method: 'rank_sum' }),
    criteria,
    contestants: contestants(['A', 'B']),
    judges: judges(2),
    // Raw scores: A 92 and B 90 on both sheets.
    scores: scoreRows({
      1: { 1: [33, 23, 18, 18], 2: [32, 22, 18, 18] },
      2: { 1: [33, 23, 18, 18], 2: [32, 22, 18, 18] },
    }),
  };

  const clean = computeCategoryResults({ ...input, deductions: [] });
  assert.deepEqual(clean.rows.map((row) => row.rank), [1, 2]);

  // 3 points off A's raw 92 leaves 89, below B's 90 on every sheet.
  const penalised = computeCategoryResults({
    ...input,
    deductions: [{ contestant_id: 1, points: 3, name: 'Exceeding Actual Performance Time', remarks: '' }],
  });
  assert.deepEqual(Object.values(penalised.rows[0].judges).map((entry) => [entry.raw, entry.net, entry.rank]), [[92, 89, 2], [92, 89, 2]]);
  assert.deepEqual(penalised.rows.map((row) => row.rank), [2, 1]);
});

test('a deduction larger than the raw score stops at zero', () => {
  const result = computeCategoryResults({
    category: category(),
    criteria,
    contestants: contestants(['A']),
    judges: judges(1),
    scores: scoreRows({ 1: { 1: [1, 1, 1, 1] } }),
    deductions: [{ contestant_id: 1, points: 10, name: 'Safety & Prohibited Acts Violation', remarks: '' }],
  });
  assert.equal(result.rows[0].judges[1].raw, 4);
  assert.equal(result.rows[0].judges[1].net, 0);
});

test('categories that do not apply deductions ignore them', () => {
  const result = computeCategoryResults({
    category: category({ apply_deductions: 0 }),
    criteria,
    contestants: contestants(['A']),
    judges: judges(1),
    scores: scoreRows({ 1: { 1: [30, 20, 18, 18] } }),
    deductions: [{ contestant_id: 1, points: 5, name: 'Safety', remarks: '' }],
  });
  assert.equal(result.rows[0].judges[1].net, 86);
  assert.equal(result.rows[0].average, 86);
  assert.deepEqual(result.rows[0].deductions, []);
});

test('incomplete sheets are left out of the average and keep the result provisional', () => {
  const result = computeCategoryResults({
    category: category(),
    criteria,
    contestants: contestants(['A', 'B']),
    judges: judges(2),
    scores: scoreRows({
      1: { 1: [30, 20, 18, 18], 2: [30, 20, 15, 15] },
      2: { 1: [32, 22, null, 18] },
    }),
    deductions: [],
  });

  const [a, b] = result.rows;
  assert.equal(a.judges[2].complete, false);
  assert.equal(a.judges[2].net, null);
  assert.equal(a.judgesComplete, 1);
  assert.equal(a.average, 86);
  assert.equal(a.complete, false);
  assert.equal(b.judges[2].filled, 0);
  assert.equal(result.isFinal, false);
  assert.deepEqual(result.judges.map((judge) => judge.completed), [2, 0]);
});

test('averages that differ only past two decimals are not treated as a tie', () => {
  const result = computeCategoryResults({
    category: category(),
    criteria,
    contestants: contestants(['A', 'B']),
    judges: judges(3),
    scores: scoreRows({
      1: { 1: [30, 20, 18, 18], 2: [30, 20, 18, 18] },
      2: { 1: [30, 20, 18, 18], 2: [30, 20, 18, 18] },
      3: { 1: [30, 20, 18, 18], 2: [30, 20, 18, 18.01] },
    }),
    deductions: [],
  });
  assert.equal(result.rows[1].rank, 1);
  assert.equal(result.rows[0].rank, 2);
});

test('rank-sum method orders by the sum of judge ranks, lowest first', () => {
  // A wins on average score, but B is ranked first by two of the three judges.
  const input = {
    criteria,
    contestants: contestants(['A', 'B']),
    judges: judges(3),
    scores: scoreRows({
      1: { 1: [35, 25, 20, 20], 2: [20, 15, 10, 10] },
      2: { 1: [30, 20, 15, 15], 2: [30, 20, 15, 16] },
      3: { 1: [30, 20, 15, 15], 2: [30, 20, 15, 16] },
    }),
    deductions: [],
  };

  const byAverage = computeCategoryResults({ ...input, category: category() });
  assert.equal(byAverage.rows[0].rank, 1);

  const byRankSum = computeCategoryResults({ ...input, category: category({ ranking_method: 'rank_sum' }) });
  assert.deepEqual(byRankSum.rows.map((row) => row.rankSum), [5, 4]);
  assert.equal(byRankSum.rows[1].rank, 1);
  assert.equal(byRankSum.rows[0].rank, 2);
  assert.equal(byRankSum.rows[1].placement, 'CHAMPION');
});

test('the 2025 Showdown sheet for judges 1, 2 and 5, re-ranked with fractional ranks', () => {
  const names = ['Surigao City', 'Dipolog City', 'Zamboanga City', 'Merged Contingent 2', 'Merged Contingent 1',
    'Tangub City', 'Oroquieta City', 'Zamboanga Sibugay', 'Ozamiz City'];
  // The rank each judge gave, in order of performance, as printed on the 2025 sheet,
  // which gave ties the best place: judge 1 has three 5s, judge 5 has two 7s.
  const printed = [
    [5, 9, 5, 5, 3, 8, 4, 2, 1],
    [5, 9, 4, 6, 7, 8, 3, 2, 1],
    [2, 7, 7, 6, 5, 9, 1, 3, 4],
  ];
  // Fractional ranking: the three tied for 5th to 7th get 6 each, the two tied for 7th and 8th get 7.5.
  const sheet = [
    [6, 9, 6, 6, 3, 8, 4, 2, 1],
    [5, 9, 4, 6, 7, 8, 3, 2, 1],
    [2, 7.5, 7.5, 6, 5, 9, 1, 3, 4],
  ];
  // Any scores in that order reproduce the ties: use one criterion and score 100 - printed rank.
  const scores = printed.flatMap((ranks, judge) => ranks.map((rank, index) => (
    { judge_id: judge + 1, contestant_id: index + 1, criterion_id: 1, score: 100 - rank }
  )));

  const result = computeCategoryResults({
    category: category({ ranking_method: 'rank_sum', placement_titles: ['CHAMPION', '1ST RUNNER UP', '2ND RUNNER UP'] }),
    criteria: [{ id: 1, name: 'Overall', description: '', weight: 100 }],
    contestants: contestants(names),
    judges: judges(3, 'submitted'),
    scores,
    deductions: [],
  });

  assert.deepEqual(result.rows.map((row) => Object.values(row.judges).map((entry) => entry.rank)),
    names.map((_, index) => sheet.map((ranks) => ranks[index])));
  assert.deepEqual(result.rows.map((row) => row.rankSum), [13, 25.5, 17.5, 18, 15, 25, 8, 7, 6]);
  // With best-place ties Dipolog and Tangub were level on 25. Fractional ranks separate them.
  assert.deepEqual(result.rows.map((row) => row.rank), [4, 9, 6, 7, 5, 8, 3, 2, 1]);
  assert.deepEqual(result.rows.map((row) => row.placement),
    [null, null, null, null, null, null, '2ND RUNNER UP', '1ST RUNNER UP', 'CHAMPION']);
});

test('a tie in the rank total goes to the higher average score', () => {
  const result = computeCategoryResults({
    category: category({ ranking_method: 'rank_sum' }),
    criteria,
    contestants: contestants(['A', 'B']),
    judges: judges(2),
    scores: scoreRows({
      1: { 1: [35, 25, 20, 20], 2: [30, 20, 15, 15] },
      2: { 1: [30, 20, 15, 15], 2: [30, 20, 15, 16] },
    }),
    deductions: [],
  });
  assert.deepEqual(result.rows.map((row) => row.rankSum), [3, 3]);
  assert.deepEqual(result.rows.map((row) => row.rank), [1, 2]);
});

test('the safety penalty costs the same however many judges sit on the panel', () => {
  const sheet = { 1: [33, 23, 18, 18], 2: [32, 22, 18, 18] };
  const penalty = [{ contestant_id: 1, points: 5, name: 'Safety & Prohibited Acts Violation', remarks: '' }];

  for (const panel of [3, 5, 7]) {
    const scores = scoreRows(Object.fromEntries(judges(panel).map((judge) => [judge.id, sheet])));
    const result = computeCategoryResults({
      category: category({ ranking_method: 'rank_sum' }),
      criteria,
      contestants: contestants(['A', 'B']),
      judges: judges(panel),
      scores,
      deductions: penalty,
    });
    assert.equal(result.rows[0].average, 87, `${panel} judges`);
    assert.ok(Object.values(result.rows[0].judges).every((entry) => entry.net === 87), `${panel} judges`);
  }
});
