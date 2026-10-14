'use strict';

// End-to-end test of the HTTP + WebSocket server against an in-memory database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, isLoopback } = require('../src/server');

let server;
let base;

async function call(method, path, body, token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function ok(method, path, body, token) {
  const result = await call(method, path, body, token);
  assert.ok(result.status < 300, `${method} ${path} -> ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

/** Opens a WebSocket and collects every event it receives. */
function listen(query) {
  return new Promise((resolve, reject) => {
    const events = [];
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?${query}`);
    socket.onmessage = (message) => events.push(JSON.parse(message.data));
    socket.onopen = () => resolve({ events, close: () => socket.close() });
    socket.onerror = () => reject(new Error('WebSocket failed to connect'));
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test.before(async () => {
  server = await startServer({ dbPath: ':memory:', port: 0, host: '127.0.0.1' });
  base = server.localUrl;
  // These tests sign judges in from this computer, which the device lock (on by default) refuses.
  await ok('PUT', '/api/admin/device-lock', { enabled: false });
});

test.after(() => server.close());

test('a new database holds the Perangat 2026 rule book', async () => {
  const state = await ok('GET', '/api/admin/state');
  assert.deepEqual(state.categories.map((category) => category.name), ['Dance Showdown', 'Best Music', 'Festival Queen']);
  assert.deepEqual(state.categories.map((category) => category.criteria.map((criterion) => criterion.weight)), [
    [35, 25, 20, 20],
    [50, 20, 15, 10, 5],
    [35, 25, 20, 20],
  ]);
  assert.equal(state.deductionTypes.length, 4);
  assert.equal(state.judges.length, 3);
  assert.ok(state.categories.every((category) => category.ranking_method === 'rank_sum'));
  assert.deepEqual(state.categories[0].placement_titles, ['CHAMPION', '1ST RUNNER UP', '2ND RUNNER UP']);
});

test('a database seeded with the old defaults is moved to sum-of-ranks once', () => {
  const { Database } = require('../src/server/db');
  const db = new Database(':memory:');
  const oldTitles = JSON.stringify(['CHAMPION', '1ST RUNNER UP', '2ND RUNNER UP', '3RD RUNNER UP', '4TH RUNNER UP']);

  // Put it back the way the first version left it, then run the migration again.
  db.run("UPDATE categories SET ranking_method = 'average'");
  db.run("UPDATE categories SET placement_titles = ? WHERE name = 'Dance Showdown'", oldTitles);
  db.raw.exec('PRAGMA user_version = 0');
  db.migrate();

  const categories = db.all('SELECT name, ranking_method, placement_titles FROM categories ORDER BY sort_order');
  assert.ok(categories.every((category) => category.ranking_method === 'rank_sum'));
  assert.equal(categories[0].placement_titles, JSON.stringify(['CHAMPION', '1ST RUNNER UP', '2ND RUNNER UP']));
  assert.equal(categories[1].placement_titles, JSON.stringify(['BEST MUSIC']));

  // A later choice of "average" is not overridden: the migration only runs once.
  db.run("UPDATE categories SET ranking_method = 'average' WHERE name = 'Best Music'");
  db.migrate();
  assert.equal(db.get("SELECT ranking_method FROM categories WHERE name = 'Best Music'").ranking_method, 'average');
  db.close();
});

test('an older database loses the "taken from" choice on deduction rules and keeps its data', () => {
  const { Database } = require('../src/server/db');
  const db = new Database(':memory:');
  const columns = () => db.raw.prepare('PRAGMA table_info(deduction_types)').all().map((column) => column.name);
  assert.equal(columns().includes('scope'), false);

  // Rebuild the column the way version 1 of the schema had it, with a recorded deduction against a rule.
  db.raw.exec("ALTER TABLE deduction_types ADD COLUMN scope TEXT NOT NULL DEFAULT 'final' CHECK (scope IN ('per_judge', 'final'))");
  db.run("INSERT INTO contestants (contestant_no, name) VALUES (1, 'Ozamiz City')");
  const safety = db.get("SELECT id FROM deduction_types WHERE name = 'Safety & Prohibited Acts Violation'");
  db.run('INSERT INTO deductions (contestant_id, deduction_type_id, quantity, points) VALUES (1, ?, 1, 5)', safety.id);
  db.raw.exec('PRAGMA user_version = 1');
  db.statements.clear();

  db.migrate();

  assert.equal(columns().includes('scope'), false);
  assert.equal(db.all('SELECT * FROM deduction_types').length, 4);
  assert.deepEqual(db.all('SELECT deduction_type_id, points FROM deductions').map((row) => ({ ...row })), [{ deduction_type_id: safety.id, points: 5 }]);
  // Running it again on an up-to-date database is harmless.
  db.migrate();
  db.close();
});

test('only loopback addresses count as the tabulation computer', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.20'), false);
});

test('admin requests carrying a foreign Origin are rejected', async () => {
  const response = await fetch(`${base}/api/admin/state`, { headers: { Origin: 'http://evil.example' } });
  assert.equal(response.status, 403);
});

test('three judges score a category over the network and the results add up', async () => {
  for (const name of ['Ozamiz City', 'Tangub City']) await ok('POST', '/api/admin/contestants', { name });

  const state = await ok('GET', '/api/admin/state');
  const dance = state.categories[0];
  const [ozamiz, tangub] = state.contestants;
  const admin = await listen('role=admin');

  // Sign-in is refused with a wrong code and accepted with the right one.
  const refused = await call('POST', '/api/judge/login', { judgeId: state.judges[0].id, accessCode: 'nope' });
  assert.equal(refused.status, 401);

  const tokens = [];
  for (const judge of state.judges) {
    const login = await ok('POST', '/api/judge/login', { judgeId: judge.id, accessCode: judge.access_code });
    tokens.push(login.token);
  }

  const judgeSocket = await listen(`token=${tokens[0]}`);
  await settle();
  assert.ok(admin.events.some((event) => event.type === 'presence' && event.onlineJudgeIds.includes(state.judges[0].id)));

  // Validation: above the criterion maximum, and without a session.
  const criterion = dance.criteria[0];
  const tooHigh = await call('PUT', '/api/judge/scores', { contestantId: ozamiz.id, criterionId: criterion.id, score: 35.5 }, tokens[0]);
  assert.equal(tooHigh.status, 400);
  const anonymous = await call('PUT', '/api/judge/scores', { contestantId: ozamiz.id, criterionId: criterion.id, score: 30 });
  assert.equal(anonymous.status, 401);

  // Submitting before everything is scored is refused.
  const early = await call('POST', `/api/judge/categories/${dance.id}/submit`, {}, tokens[0]);
  assert.equal(early.status, 400);

  const scoresByJudge = [
    { [ozamiz.id]: [33, 23.5, 18.5, 18], [tangub.id]: [31, 21, 17, 16] },
    { [ozamiz.id]: [34, 24, 19, 19], [tangub.id]: [30, 20, 16, 16] },
    { [ozamiz.id]: [32, 23, 18, 18], [tangub.id]: [32, 22, 18, 17] },
  ];
  for (const [index, sheet] of scoresByJudge.entries()) {
    for (const [contestantId, values] of Object.entries(sheet)) {
      for (const [position, score] of values.entries()) {
        await ok('PUT', '/api/judge/scores', {
          contestantId: Number(contestantId),
          criterionId: dance.criteria[position].id,
          score,
        }, tokens[index]);
      }
    }
  }
  await settle();
  assert.ok(admin.events.some((event) => event.type === 'scores' && event.categoryId === dance.id));
  // Score events are for the tabulator only; a judge never hears about another judge's scoring.
  assert.equal(judgeSocket.events.some((event) => event.type === 'scores'), false);

  // A judge only ever receives their own sheet.
  const mine = await ok('GET', '/api/judge/sheets', undefined, tokens[0]);
  assert.equal(mine.sheets.length, 3);
  assert.equal(mine.sheets[0].rows[0].raw, 93);
  assert.equal(mine.sheets[0].rows[0].rank, 1);
  assert.equal(JSON.stringify(mine).includes('access_code'), false);

  // Tangub ran 6:10 on stage (1 point) and committed a safety violation (5 points): 6 off every judge's raw score.
  const types = Object.fromEntries(state.deductionTypes.map((type) => [type.name, type.id]));
  const within = await call('POST', '/api/admin/deductions', {
    contestantId: tangub.id, typeId: types['Exceeding Actual Performance Time'], measuredSeconds: 340,
  });
  assert.equal(within.status, 400);
  const overtime = await ok('POST', '/api/admin/deductions', {
    contestantId: tangub.id, typeId: types['Exceeding Actual Performance Time'], measuredSeconds: 370,
  });
  assert.equal(overtime.points, 1);
  await ok('POST', '/api/admin/deductions', { contestantId: tangub.id, typeId: types['Safety & Prohibited Acts Violation'] });

  for (const token of tokens) await ok('POST', `/api/judge/categories/${dance.id}/submit`, {}, token);

  // A submitted sheet is locked until the tabulator reopens it.
  const edit = { contestantId: ozamiz.id, criterionId: criterion.id, score: 20 };
  assert.equal((await call('PUT', '/api/judge/scores', edit, tokens[0])).status, 409);
  await ok('POST', '/api/admin/scoresheets/reopen', { judgeId: state.judges[0].id, categoryId: dance.id });
  await ok('PUT', '/api/judge/scores', { ...edit, score: 33 }, tokens[0]);
  await ok('POST', `/api/judge/categories/${dance.id}/submit`, {}, tokens[0]);
  await settle();
  assert.ok(judgeSocket.events.some((event) => event.type === 'sheets' && event.judgeId === state.judges[0].id));

  const results = await ok('GET', '/api/admin/results');
  const [danceResult, musicResult] = results.categories;
  const [first, second] = danceResult.rows;

  assert.equal(danceResult.isFinal, true);
  assert.deepEqual(Object.values(first.judges).map((judge) => judge.net), [93, 96, 91]);
  assert.equal(first.average, 93.333333);
  assert.equal(first.rank, 1);
  assert.equal(first.placement, 'CHAMPION');

  // Sum of ranks decides: every judge placed Ozamiz first and Tangub second.
  assert.equal(danceResult.category.ranking_method, 'rank_sum');
  assert.deepEqual(Object.values(first.judges).map((judge) => judge.rank), [1, 1, 1]);
  assert.deepEqual([first.rankSum, second.rankSum], [3, 6]);

  // Tangub scored 85, 82 and 89, less 1 (overtime) and 5 (safety) on every judge's sheet.
  assert.deepEqual(Object.values(second.judges).map((judge) => judge.net), [79, 76, 83]);
  assert.equal(second.average, 79.333333);
  assert.equal(second.placement, '1ST RUNNER UP');

  // Best Music does not take the Dance Showdown time penalties.
  assert.equal(musicResult.isFinal, false);
  assert.deepEqual(musicResult.rows[1].deductions, []);

  admin.close();
  judgeSocket.close();
});

test('adding a contingent reopens submitted sheets so it can be scored', async () => {
  await ok('POST', '/api/admin/contestants', { name: 'Oroquieta City' });
  const results = await ok('GET', '/api/admin/results');
  assert.equal(results.categories[0].isFinal, false);
  assert.ok(results.categories[0].judges.every((judge) => judge.status === 'draft'));
});

test('duplicate numbers are rejected with a readable message', async () => {
  const duplicate = await call('POST', '/api/admin/contestants', { name: 'Clone', contestant_no: 1 });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /already in use/);
});

test('a criterion weight cannot drop below a score already given', async () => {
  const state = await ok('GET', '/api/admin/state');
  const criterion = state.categories[0].criteria[0];
  const lowered = await call('PUT', `/api/admin/criteria/${criterion.id}`, { ...criterion, weight: 10 });
  assert.equal(lowered.status, 409);
});

test('the judge page is served at the root and unknown API routes return JSON', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>/);
  const missing = await call('GET', '/api/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'Not found.');
});

test('a new judge is numbered automatically with the lowest free number', async () => {
  const before = (await ok('GET', '/api/admin/state')).judges.map((judge) => judge.judge_no);
  const added = [];
  for (const name of ['Extra A', 'Extra B']) added.push((await ok('POST', '/api/admin/judges', { name })).id);
  const numberOf = async (id) => (await ok('GET', '/api/admin/state')).judges.find((judge) => judge.id === id).judge_no;
  assert.equal(await numberOf(added[0]), Math.max(...before) + 1);
  assert.equal(await numberOf(added[1]), Math.max(...before) + 2);

  // Deleting a judge frees their number for the next one added.
  await ok('DELETE', `/api/admin/judges/${added[0]}`);
  const refill = (await ok('POST', '/api/admin/judges', { name: 'Extra C' })).id;
  assert.equal(await numberOf(refill), Math.max(...before) + 1);

  for (const id of [added[1], refill]) await ok('DELETE', `/api/admin/judges/${id}`);
});

test('the chairman and the tabulator are set together, and a deleted chairman is cleared', async () => {
  const { judges } = await ok('GET', '/api/admin/state');
  await ok('PUT', '/api/admin/signatories', { chairmanJudgeId: String(judges[1].id), tabulatorName: '  Marc Mahinay ' });
  let state = await ok('GET', '/api/admin/state');
  assert.equal(state.chairmanJudgeId, judges[1].id);
  assert.deepEqual(state.judges.map((judge) => judge.is_chairman), judges.map((_, index) => index === 1));
  assert.equal(state.settings.tabulator_name, 'Marc Mahinay');

  assert.equal((await call('PUT', '/api/admin/signatories', { chairmanJudgeId: 99999, tabulatorName: '' })).status, 404);

  // A chairman who is deleted leaves the board without one.
  const temporary = (await ok('POST', '/api/admin/judges', { name: 'Temporary' })).id;
  await ok('PUT', '/api/admin/signatories', { chairmanJudgeId: temporary, tabulatorName: 'Marc Mahinay' });
  await ok('DELETE', `/api/admin/judges/${temporary}`);
  state = await ok('GET', '/api/admin/state');
  assert.equal(state.chairmanJudgeId, null);
  assert.equal(state.judges.some((judge) => judge.is_chairman), false);

  // No chairman at all.
  await ok('PUT', '/api/admin/signatories', { chairmanJudgeId: '', tabulatorName: '' });
  state = await ok('GET', '/api/admin/state');
  assert.equal(state.chairmanJudgeId, null);
  assert.equal(state.settings.tabulator_name, '');
});

test('the judges\' vote on a tie is recorded only for a tie that is waiting for one', async () => {
  // Every judge gives two new contingents in Festival Queen the same scores: a tie on rank total and average.
  const state = await ok('GET', '/api/admin/state');
  const queen = state.categories[2];
  const added = [];
  for (const name of ['Tie A', 'Tie B']) added.push((await ok('POST', '/api/admin/contestants', { name, categoryIds: [queen.id] })).id);
  const tokens = [];
  for (const judge of state.judges.filter((entry) => entry.categoryIds.includes(queen.id))) {
    tokens.push((await ok('POST', '/api/judge/login', { judgeId: judge.id, accessCode: judge.access_code })).token);
  }
  for (const token of tokens) {
    for (const contestantId of added) {
      for (const criterion of queen.criteria) {
        await ok('PUT', '/api/judge/scores', { contestantId, criterionId: criterion.id, score: criterion.weight - 5 }, token);
      }
    }
  }

  const queenResult = async () => (await ok('GET', '/api/admin/results')).categories.find((entry) => entry.category.id === queen.id);
  let result = await queenResult();
  assert.deepEqual(result.pendingVotes.map((level) => [...level.contestantIds].sort()), [[...added].sort()]);

  // A vote naming contingents that are not tied, or naming one twice, is refused.
  assert.equal((await call('POST', '/api/admin/tie-votes', { categoryId: queen.id, placing: [added[0], state.contestants[0].id] })).status, 409);
  assert.equal((await call('POST', '/api/admin/tie-votes', { categoryId: queen.id, placing: [added[0], added[0]] })).status, 409);

  await ok('POST', '/api/admin/tie-votes', { categoryId: queen.id, placing: [added[1], added[0]], note: '2-1' });
  result = await queenResult();
  assert.deepEqual(result.pendingVotes, []);
  const rankOf = (id) => result.rows.find((row) => row.contestant.id === id).rank;
  assert.equal(rankOf(added[1]) + 1, rankOf(added[0]));
  assert.equal(result.votes[0].note, '2-1');

  // Clearing the vote puts them back to sharing the place.
  await ok('DELETE', `/api/admin/tie-votes/${result.votes[0].id}`);
  result = await queenResult();
  assert.equal(result.pendingVotes.length, 1);

  for (const id of added) await ok('DELETE', `/api/admin/contestants/${id}`);
});
