'use strict';

// The tabulating team's encoder screen: pairing, typing in paper scoresheets,
// and reading them from a photo. The photo reader is replaced by a stand-in
// that returns a fixed reading, so nothing is sent over the internet.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../src/server');
const { interpretScan, parseDataUrl } = require('../src/server/scan');

let server;
let state;
let reading = null;      // what the stand-in photo reader returns next
let lastLayout = null;   // what it was asked to read

async function call(method, path, body, token) {
  const response = await fetch(server.localUrl + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function ok(method, path, body, token) {
  const result = await call(method, path, body, token);
  assert.ok(result.status < 300, `${method} ${path} -> ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

const refresh = async () => { state = await ok('GET', '/api/admin/state'); };

/** Pairs a device and has the tabulator approve it, assigning it every judge unless told otherwise. */
async function pairedToken(name = 'Encoder', judgeIds = state.judges.map((judge) => judge.id)) {
  const pairing = await ok('POST', '/api/encode/pair', { accessCode: state.encoders.accessCode, name });
  await refresh();
  const device = state.encoders.devices.find((entry) => entry.pairing_code === pairing.pairingCode && entry.name === name);
  await ok('POST', `/api/admin/encoders/${device.id}/approve`, { judgeIds });
  return pairing.token;
}

test.before(async () => {
  server = await startServer({
    dbPath: ':memory:',
    port: 0,
    host: '127.0.0.1',
    readSheet: async (image, layout) => {
      parseDataUrl(image);
      lastLayout = layout;
      return reading;
    },
  });
  for (const name of ['Surigao City', 'Dipolog City']) await ok('POST', '/api/admin/contestants', { name });
  await refresh();
});

test.after(() => server.close());

test('a device pairs with the team code and can do nothing until the tabulator approves it', async () => {
  assert.match(state.encoders.accessCode, /^\d{6}$/);
  assert.equal((await call('POST', '/api/encode/pair', { accessCode: '000000', name: 'Nobody' })).status, 401);
  assert.equal((await call('POST', '/api/encode/pair', { accessCode: state.encoders.accessCode, name: '' })).status, 400);

  const pairing = await ok('POST', '/api/encode/pair', { accessCode: state.encoders.accessCode, name: 'Liza' });
  assert.match(pairing.pairingCode, /^\d{4}$/);
  assert.equal((await ok('GET', '/api/encode/status', undefined, pairing.token)).status, 'pending');
  assert.equal((await call('GET', '/api/encode/setup', undefined, pairing.token)).status, 403);

  await refresh();
  const device = state.encoders.devices.find((entry) => entry.name === 'Liza');
  assert.equal(device.status, 'pending');
  assert.equal(device.pairing_code, pairing.pairingCode);
  assert.equal('token' in device, false, 'the admin console never sees device tokens');

  await ok('POST', `/api/admin/encoders/${device.id}/approve`, { judgeIds: state.judges.map((judge) => judge.id) });
  assert.equal((await ok('GET', '/api/encode/status', undefined, pairing.token)).status, 'paired');
  const setup = await ok('GET', '/api/encode/setup', undefined, pairing.token);
  assert.deepEqual(setup.categories.map((category) => category.name), ['Dance Showdown', 'Best Music', 'Festival Queen']);

  // Unpairing on the tabulation computer cuts the device off.
  await ok('DELETE', `/api/admin/encoders/${device.id}`);
  assert.equal((await call('GET', '/api/encode/setup', undefined, pairing.token)).status, 401);
});

test('an encoder enters sheets only for the judges assigned to it', async () => {
  const dance = state.categories[0];
  const [first, second] = state.judges;
  const sheetOf = (judge, token) => call('GET', `/api/encode/sheet?categoryId=${dance.id}&judgeId=${judge.id}`, undefined, token);

  // Approved with no judges: the screen opens, but there is nothing to choose and nothing it may open.
  const idle = await pairedToken('No judges yet', []);
  const empty = await ok('GET', '/api/encode/setup', undefined, idle);
  assert.deepEqual(empty.judges, []);
  assert.deepEqual(empty.categories, []);
  const refused = await sheetOf(first, idle);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /not assigned to you/);
  const cell = { contestantId: state.contestants[0].id, criterionId: dance.criteria[0].id, score: 30 };
  assert.equal((await call('PUT', '/api/encode/sheet', { categoryId: dance.id, judgeId: first.id, cells: [cell] }, idle)).status, 409);
  assert.equal((await call('POST', '/api/encode/sheet/submit', { categoryId: dance.id, judgeId: first.id }, idle)).status, 409);
  assert.equal((await call('POST', '/api/encode/scan', { categoryId: dance.id, judgeId: first.id, image: 'data:image/jpeg;base64,AAAA' }, idle)).status, 409);

  // The tabulator assigns it Judge 1 only.
  await refresh();
  const device = state.encoders.devices.find((entry) => entry.name === 'No judges yet');
  assert.deepEqual(device.judgeIds, []);
  await ok('PUT', `/api/admin/encoders/${device.id}/judges`, { judgeIds: [first.id] });
  const setup = await ok('GET', '/api/encode/setup', undefined, idle);
  assert.deepEqual(setup.judges.map((judge) => judge.id), [first.id]);
  assert.ok(setup.categories.every((category) => category.judgeIds.length === 1 && category.judgeIds[0] === first.id));
  assert.equal((await sheetOf(first, idle)).status, 200);
  assert.equal((await sheetOf(second, idle)).status, 409);

  // Unassigning takes it away again; a judge who does not exist cannot be assigned.
  await ok('PUT', `/api/admin/encoders/${device.id}/judges`, { judgeIds: [] });
  assert.equal((await sheetOf(first, idle)).status, 409);
  assert.equal((await call('PUT', `/api/admin/encoders/${device.id}/judges`, { judgeIds: [99999] })).status, 404);
});

test('a new team code stops new pairings with the old one, and paired devices stay paired', async () => {
  const token = await pairedToken('Before');
  const old = state.encoders.accessCode;
  await ok('POST', '/api/admin/encoder-code');
  await refresh();
  assert.notEqual(state.encoders.accessCode, old);
  assert.equal((await call('POST', '/api/encode/pair', { accessCode: old, name: 'Late' })).status, 401);
  assert.equal((await call('GET', '/api/encode/setup', undefined, token)).status, 200);
});

test('an encoder types in a judge\'s paper sheet, edits it, and the judge sees it', async () => {
  const token = await pairedToken('Mark');
  const dance = state.categories[0];
  const judge = state.judges[0];
  const [surigao, dipolog] = state.contestants;
  const query = `/api/encode/sheet?categoryId=${dance.id}&judgeId=${judge.id}`;
  const cells = (contestant, values) => values.map((score, index) => ({ contestantId: contestant.id, criterionId: dance.criteria[index].id, score }));

  // A score above a criterion's maximum is refused, and nothing in the batch is saved.
  const tooHigh = await call('PUT', '/api/encode/sheet', {
    categoryId: dance.id, judgeId: judge.id, cells: [...cells(surigao, [30, 20, 18, 18]), ...cells(dipolog, [36, 20, 18, 18])],
  }, token);
  assert.equal(tooHigh.status, 400);
  assert.equal((await ok('GET', query, undefined, token)).sheet.rows[0].filled, 0);

  let { sheet } = await ok('PUT', '/api/encode/sheet', {
    categoryId: dance.id, judgeId: judge.id, cells: [...cells(surigao, [30, 20, 18, 18]), ...cells(dipolog, [31, 21, 17, 16])],
  }, token);
  assert.deepEqual(sheet.rows.map((row) => row.raw), [86, 85]);
  assert.deepEqual(sheet.encodedBy, ['Mark']);

  // Editing one cell, and clearing another.
  ({ sheet } = await ok('PUT', '/api/encode/sheet', {
    categoryId: dance.id, judgeId: judge.id,
    cells: [{ contestantId: dipolog.id, criterionId: dance.criteria[0].id, score: 33.5 }, { contestantId: dipolog.id, criterionId: dance.criteria[3].id, score: null }],
  }, token));
  assert.equal(sheet.rows[1].scores[dance.criteria[0].id], 33.5);
  assert.equal(sheet.rows[1].complete, false);

  // The judge's own device shows the same scores.
  const login = await ok('POST', '/api/judge/login', { judgeId: judge.id, accessCode: judge.access_code });
  const mine = (await ok('GET', '/api/judge/sheets', undefined, login.token)).sheets.find((entry) => entry.category.id === dance.id);
  assert.equal(mine.rows[1].scores[dance.criteria[0].id], 33.5);

  // A judge who does not score a category cannot be encoded for it.
  await ok('PUT', `/api/admin/judges/${state.judges[2].id}`, { name: state.judges[2].name, categoryIds: [state.categories[1].id] });
  assert.equal((await call('GET', `/api/encode/sheet?categoryId=${dance.id}&judgeId=${state.judges[2].id}`, undefined, token)).status, 404);
});

test('an encoder submits a fully encoded sheet, which then locks until the tabulator reopens it', async () => {
  const token = await pairedToken('Submitter');
  const music = state.categories[1];
  const judge = state.judges[1];
  const body = { categoryId: music.id, judgeId: judge.id };

  assert.equal((await call('POST', '/api/encode/sheet/submit', body, token)).status, 400, 'not fully scored yet');
  const cells = state.contestants.flatMap((contestant) => music.criteria.map((criterion) => ({
    contestantId: contestant.id, criterionId: criterion.id, score: criterion.weight - 1,
  })));
  await ok('PUT', '/api/encode/sheet', { ...body, cells }, token);
  const { sheet } = await ok('POST', '/api/encode/sheet/submit', body, token);
  assert.equal(sheet.status, 'submitted');

  const locked = await call('PUT', '/api/encode/sheet', { ...body, cells: cells.slice(0, 1) }, token);
  assert.equal(locked.status, 409);

  await ok('POST', '/api/admin/scoresheets/reopen', body);
  assert.equal((await call('PUT', '/api/encode/sheet', { ...body, cells: cells.slice(0, 1) }, token)).status, 200);
});

test('a photo is read into proposals, checked, and nothing is saved until the encoder saves', async () => {
  const token = await pairedToken('Scanner');
  const queen = state.categories[2];
  const judge = state.judges[0];
  const [surigao, dipolog] = state.contestants;
  reading = {
    sheet_heading: 'FESTIVAL QUEEN — JUDGE 1 SCORESHEET',
    rows: [
      { contestant_no: surigao.contestant_no, scores: [30, 21.5, 18, 17], total_written: 86.5, unclear: [] },
      { contestant_no: dipolog.contestant_no, scores: [40, 20, null, 15], total_written: null, unclear: [2] },
    ],
    notes: '',
  };

  const scan = await ok('POST', '/api/encode/scan', { categoryId: queen.id, judgeId: judge.id, image: 'data:image/jpeg;base64,AAAA' }, token);
  assert.equal(lastLayout.category.id, queen.id);
  assert.deepEqual(lastLayout.criteria.map((criterion) => criterion.weight), [35, 25, 20, 20]);
  assert.deepEqual(scan.cells.filter((cell) => cell.contestantId === surigao.id).map((cell) => cell.value), [30, 21.5, 18, 17]);
  const dipologCells = scan.cells.filter((cell) => cell.contestantId === dipolog.id);
  assert.equal(dipologCells[0].value, null);
  assert.match(dipologCells[0].problem, /above the maximum of 35/);
  assert.match(dipologCells[2].problem, /could not be read/);

  const sheet = (await ok('GET', `/api/encode/sheet?categoryId=${queen.id}&judgeId=${judge.id}`, undefined, token)).sheet;
  assert.equal(sheet.rows[0].filled, 0, 'scanning saves nothing');

  assert.equal((await call('POST', '/api/encode/scan', { categoryId: queen.id, judgeId: judge.id, image: 'not a photo' }, token)).status, 400);
  assert.equal((await call('POST', '/api/encode/scan', { categoryId: queen.id, judgeId: judge.id, image: 'data:image/jpeg;base64,AAAA' })).status, 401);
});

test('a photo up to a few megabytes is accepted on the scan route only', async () => {
  const token = await pairedToken('Big photo');
  reading = { sheet_heading: '', rows: [], notes: '' };
  const image = `data:image/jpeg;base64,${'A'.repeat(3 * 1024 * 1024)}`;
  const dance = state.categories[0];
  const scan = await call('POST', '/api/encode/scan', { categoryId: dance.id, judgeId: state.judges[0].id, image }, token);
  assert.equal(scan.status, 200);
  // Every other route keeps the small limit.
  assert.equal((await call('PUT', '/api/encode/sheet', { categoryId: dance.id, judgeId: state.judges[0].id, cells: [], padding: image }, token)).status, 413);
});

test('reading a photo is not available until a Claude API key is set, and the key is never sent back', async () => {
  const plain = await startServer({ dbPath: ':memory:', port: 0, host: '127.0.0.1' });
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const request = async (method, path, body, token) => {
      const response = await fetch(plain.localUrl + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    let admin = (await request('GET', '/api/admin/state')).body;
    assert.equal(admin.scan.ready, false);

    const pairing = (await request('POST', '/api/encode/pair', { accessCode: admin.encoders.accessCode, name: 'X' })).body;
    admin = (await request('GET', '/api/admin/state')).body;
    await request('POST', `/api/admin/encoders/${admin.encoders.devices[0].id}/approve`, { judgeIds: admin.judges.map((judge) => judge.id) });
    const scan = await request('POST', '/api/encode/scan', {
      categoryId: admin.categories[0].id, judgeId: admin.judges[0].id, image: 'data:image/jpeg;base64,AAAA',
    }, pairing.token);
    assert.equal(scan.status, 503);
    assert.match(scan.body.error, /not set up/);

    assert.equal((await request('PUT', '/api/admin/scan-key', { apiKey: 'hello' })).status, 400);
    await request('PUT', '/api/admin/scan-key', { apiKey: 'sk-ant-test-0123456789' });
    const raw = await fetch(`${plain.localUrl}/api/admin/state`).then((response) => response.text());
    assert.equal(raw.includes('sk-ant-test'), false);
    admin = JSON.parse(raw);
    assert.equal(admin.scan.ready, true);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    await plain.close();
  }
});

// ---- Checking a reading -------------------------------------------------------

const layout = {
  criteria: [{ id: 11, name: 'Performance', weight: 35 }, { id: 12, name: 'Music', weight: 20 }],
  contestants: [{ id: 1, contestant_no: 1, name: 'A' }, { id: 2, contestant_no: 2, name: 'B' }, { id: 3, contestant_no: 3, name: 'C' }],
};

test('a reading is matched to the sheet by contingent number and checked cell by cell', () => {
  const result = interpretScan({
    sheet_heading: 'X',
    rows: [
      { contestant_no: 2, scores: [30, 18.555], total_written: 48.56, unclear: [] },
      { contestant_no: 1, scores: [-1, 21], total_written: null, unclear: [] },
      { contestant_no: 9, scores: [1, 1], total_written: null, unclear: [] },
      { contestant_no: 2, scores: [1, 1], total_written: null, unclear: [] },
    ],
    notes: 'Coffee stain on row 3.',
  }, layout);

  const cell = (contestantId, criterionId) => result.cells.find((entry) => entry.contestantId === contestantId && entry.criterionId === criterionId);
  assert.deepEqual(cell(2, 11), { contestantId: 2, criterionId: 11, value: 30, problem: null });
  assert.equal(cell(2, 12).value, 18.56);
  assert.match(cell(2, 12).problem, /two decimals/);
  assert.equal(cell(1, 11).value, null);
  assert.match(cell(1, 11).problem, /below zero/);
  assert.equal(cell(1, 12).value, null);
  assert.match(cell(1, 12).problem, /above the maximum of 20/);
  assert.equal(result.notes, 'Coffee stain on row 3.');
  assert.ok(result.warnings.some((warning) => /numbered 9/.test(warning)));
  assert.ok(result.warnings.some((warning) => /appears twice/.test(warning)));
  assert.ok(result.warnings.some((warning) => /Not found on the photo: 3\. C/.test(warning)));
});

test('a row whose scores do not add up to the total the judge wrote is flagged', () => {
  const result = interpretScan({
    sheet_heading: '',
    rows: [
      { contestant_no: 1, scores: [30, 18], total_written: 49, unclear: [] },
      { contestant_no: 2, scores: [30, 18], total_written: 48, unclear: [] },
      { contestant_no: 3, scores: [30, 18], total_written: null, unclear: [1] },
    ],
    notes: '',
  }, layout);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Contingent 1 \(A\): the scores add up to 48, but the judge wrote a total of 49/);
  assert.equal(result.cells.find((entry) => entry.contestantId === 3 && entry.criterionId === 12).problem, 'Hard to read on the photo. Check it.');
});
