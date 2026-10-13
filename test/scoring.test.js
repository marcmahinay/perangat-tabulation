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
    deductions: [{ contestant_id: 2, points: 1, scope: 'per_judge', name: 'Exceeding Actual Performance Time', remarks: '' }],
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

test('per-judge deductions come off each judge, final deductions off the average', () => {
  const result = computeCategoryResults({
    category: category(),
    criteria,
    contestants: contestants(['A', 'B']),
    judges: judges(3, 'submitted'),
    scores: scoreRows({
      1: { 1: [30, 20, 18, 18], 2: [30, 20, 15, 15] },
      2: { 1: [32, 22, 18, 18], 2: [30, 20, 15, 15] },
      3: { 1: [31, 21, 18, 18], 2: [30, 20, 15, 15] },
    }),
    deductions: [
      { contestant_id: 1, points: 1, scope: 'per_judge', name: 'Exceeding Entrance Time', remarks: '' },
      { contestant_id: 1, points: 5, scope: 'final', name: 'Safety & Prohibited Acts Violation', remarks: '' },
    ],
  });

  const [a, b] = result.rows;
  assert.deepEqual([a.judges[1].net, a.judges[2].net, a.judges[3].net], [85, 89, 87]);
  assert.equal(a.average, 87);
  assert.equal(a.final, 82);
  assert.equal(b.final, 80);
  assert.equal(a.rank, 1);
  assert.equal(a.placement, 'CHAMPION');
  assert.equal(b.placement, '1ST RUNNER UP');
  assert.equal(result.isFinal, true);
});

test('categories that do not apply deductions ignore them', () => {
  const result = computeCategoryResults({
    category: category({ apply_deductions: 0 }),
    criteria,
    contestants: contestants(['A']),
    judges: judges(1),
    scores: scoreRows({ 1: { 1: [30, 20, 18, 18] } }),
    deductions: [{ contestant_id: 1, points: 5, scope: 'final', name: 'Safety', remarks: '' }],
  });
  assert.equal(result.rows[0].final, 86);
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

test('rank-sum reproduces the 2025 Showdown sheet for judges 1, 2 and 5', () => {
  const names = ['Surigao City', 'Dipolog City', 'Zamboanga City', 'Merged Contingent 2', 'Merged Contingent 1',
    'Tangub City', 'Oroquieta City', 'Zamboanga Sibugay', 'Ozamiz City'];
  // The rank each judge gave, in order of performance, as printed on the sheet.
  const sheet = [
    [5, 9, 5, 5, 3, 8, 4, 2, 1],
    [5, 9, 4, 6, 7, 8, 3, 2, 1],
    [2, 7, 7, 6, 5, 9, 1, 3, 4],
  ];
  // Any scores in that order give those ranks: use one criterion and score 100 - rank.
  const scores = sheet.flatMap((ranks, judge) => ranks.map((rank, index) => (
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
  assert.deepEqual(result.rows.map((row) => row.rankSum), [12, 25, 16, 17, 15, 25, 8, 7, 6]);
  // Dipolog and Tangub tie on rank total and on average score, so they share 8th.
  assert.deepEqual(result.rows.map((row) => row.rank), [4, 8, 6, 7, 5, 8, 3, 2, 1]);
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

test('with rank-sum, a final-score deduction comes off every judge before ranking', () => {
  const input = {
    criteria,
    contestants: contestants(['A', 'B']),
    judges: judges(2),
    scores: scoreRows({
      1: { 1: [33, 23, 18, 18], 2: [32, 22, 18, 18] },
      2: { 1: [33, 23, 18, 18], 2: [32, 22, 18, 18] },
    }),
    deductions: [{ contestant_id: 1, points: 5, scope: 'final', name: 'Safety & Prohibited Acts Violation', remarks: '' }],
  };

  // Without the penalty A (92) beats B (90) on every sheet; with it A drops to 87 and B wins.
  const result = computeCategoryResults({ ...input, category: category({ ranking_method: 'rank_sum' }) });
  const [a, b] = result.rows;
  assert.deepEqual(Object.values(a.judges).map((entry) => [entry.deduction, entry.net, entry.rank]), [[5, 87, 2], [5, 87, 2]]);
  assert.deepEqual([a.rankSum, b.rankSum], [4, 2]);
  assert.equal(b.rank, 1);
  assert.equal(a.finalDeduction, 0);
  assert.equal(a.final, 87);

  // Same cost as the rule book's "5 points from the final score": the average ends up 5 lower either way.
  const byAverage = computeCategoryResults({ ...input, category: category({ ranking_method: 'average' }) });
  assert.equal(byAverage.rows[0].final, a.final);
});

test('the safety penalty costs the same however many judges sit on the panel', () => {
  const sheet = { 1: [33, 23, 18, 18], 2: [32, 22, 18, 18] };
  const penalty = [{ contestant_id: 1, points: 5, scope: 'final', name: 'Safety & Prohibited Acts Violation', remarks: '' }];

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
