'use strict';

// A judge's phone, linked from their own scoresheet, photographs their paper
// sheet; the reading waits on the judge's device until they look at it. The
// device lock stays on: the laptop is registered, the phone is not.

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startServer } = require('../src/server');

const LAPTOP = { ip: '10.0.0.21', mac: 'A4:83:E7:00:01:01' };
const PHONE = { ip: '10.0.0.88', mac: 'DA:A1:19:00:02:02' };

let server;
let state;
let judge;
let session;      // the judge's token on their laptop
let reading;      // what the stand-in photo reader returns next

function identify(req) {
  const device = req.headers['x-test-device'];
  return device ? { ...JSON.parse(device), local: false } : { ip: '127.0.0.1', mac: null, local: true };
}

async function call(method, path, { body, token, from } = {}) {
  const response = await fetch(server.localUrl + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(from ? { 'x-test-device': JSON.stringify(from) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, type, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}

const asJudge = (method, path, body) => call(method, `/api/judge${path}`, { body, token: session, from: LAPTOP });
const asPhone = (token, method, path, body) => call(method, `/api/snap${path}`, { body, token, from: PHONE });

async function linkPhone() {
  const { body } = await asJudge('POST', '/phone/link');
  const linked = await call('POST', '/api/snap/link', { body: { code: body.code }, from: PHONE });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  return linked.body.token;
}

/** Opens the judge's live socket and keeps every event it receives. */
function listen() {
  return new Promise((resolve, reject) => {
    const events = [];
    const socket = new WebSocket(`${server.localUrl.replace('http', 'ws')}/ws?token=${session}`);
    socket.on('message', (data) => events.push(JSON.parse(data)));
    socket.on('open', () => resolve({ events, close: () => socket.close() }));
    socket.on('error', reject);
  });
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test.before(async () => {
  server = await startServer({
    dbPath: ':memory:', port: 0, host: '127.0.0.1', identify,
    readSheet: async () => reading,
  });
  await call('POST', '/api/admin/contestants', { body: { name: 'Surigao City' } });
  await call('POST', '/api/admin/contestants', { body: { name: 'Dipolog City' } });
  state = (await call('GET', '/api/admin/state')).body;
  judge = state.judges[0];
  // The lock is on (the default) and only the laptop is registered.
  await call('PUT', `/api/admin/judges/${judge.id}`, { body: { name: judge.name, device_mac: LAPTOP.mac } });
  session = (await call('POST', '/api/judge/login', { body: { judgeId: judge.id, accessCode: judge.access_code }, from: LAPTOP })).body.token;
  assert.ok(session);
});

test.after(() => server.close());

test('the judge shows a link code and QR code; the phone links with it once', async () => {
  const { status, body } = await asJudge('POST', '/phone/link');
  assert.equal(status, 200);
  assert.match(body.code, /^\d{6}$/);
  assert.match(body.url, new RegExp(`/snap/#${body.code}$`));
  assert.match(body.qr, /^<svg/);

  // The phone cannot open the judge pages, the lock is on; it does not need to.
  assert.equal((await call('GET', '/judge/', { from: PHONE })).status, 403);

  const live = await listen();
  assert.equal((await call('POST', '/api/snap/link', { body: { code: '000000' }, from: PHONE })).status, 401);
  const linked = await call('POST', '/api/snap/link', { body: { code: body.code }, from: PHONE });
  assert.equal(linked.status, 201);
  assert.equal((await call('POST', '/api/snap/link', { body: { code: body.code }, from: PHONE })).status, 401, 'a code works once');
  await settle();
  assert.ok(live.events.some((event) => event.type === 'phone' && event.linked === true));
  live.close();

  assert.ok((await asJudge('GET', '/phone')).body.phone);
  const me = await asPhone(linked.body.token, 'GET', '/me');
  assert.equal(me.body.judge.id, judge.id);
  assert.deepEqual(me.body.categories.map((category) => category.name), ['Dance Showdown', 'Best Music', 'Festival Queen']);
  assert.equal((await call('GET', '/api/admin/state')).body.judges[0].phone_linked, true);
});

test('a photo from the phone is read and waits on the judge\'s own device, saving nothing', async () => {
  const token = await linkPhone();
  const dance = state.categories[0];
  const [surigao, dipolog] = state.contestants;
  reading = {
    sheet_heading: 'DANCE SHOWDOWN',
    rows: [
      { contestant_no: surigao.contestant_no, scores: [30, 20, 18, 18], total_written: 86, unclear: [] },
      { contestant_no: dipolog.contestant_no, scores: [31, 21, null, 40], total_written: null, unclear: [2] },
    ],
    notes: '',
  };
  const live = await listen();
  const sent = await asPhone(token, 'POST', '/scan', { categoryId: dance.id, image: 'data:image/jpeg;base64,/9j/AAAA' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(sent.body, { read: 6, flagged: 2, warnings: 0, delivered: true });
  await settle();
  assert.deepEqual(live.events.filter((event) => event.type === 'scan'), [{ type: 'scan', categoryId: dance.id }]);
  live.close();

  const { scan } = (await asJudge('GET', '/scans/latest')).body;
  assert.equal(scan.categoryId, dance.id);
  assert.equal(scan.cells.find((cell) => cell.contestantId === surigao.id && cell.criterionId === dance.criteria[0].id).value, 30);
  assert.match(scan.cells.find((cell) => cell.contestantId === dipolog.id && cell.criterionId === dance.criteria[3].id).problem, /above the maximum/);

  const photo = await asJudge('GET', '/scans/photo');
  assert.equal(photo.status, 200);
  assert.equal(photo.type, 'image/jpeg');
  assert.ok(photo.body.length > 0);

  const sheet = (await asJudge('GET', '/sheets')).body.sheets.find((entry) => entry.category.id === dance.id);
  assert.ok(sheet.rows.every((row) => row.filled === 0), 'reading a photo saves nothing');

  await asJudge('DELETE', '/scans/latest');
  assert.equal((await asJudge('GET', '/scans/latest')).body.scan, null);
});

test('a phone sends photos only for categories its judge scores and has not submitted', async () => {
  const token = await linkPhone();
  const image = 'data:image/jpeg;base64,/9j/AAAA';
  reading = { sheet_heading: '', rows: [], notes: '' };
  const [dance, music] = state.categories;

  await call('PUT', `/api/admin/judges/${judge.id}`, { body: { name: judge.name, categoryIds: [dance.id] } });
  assert.equal((await asPhone(token, 'POST', '/scan', { categoryId: music.id, image })).status, 404);

  // Submitting needs every cell scored; fill them the judge's way.
  for (const contestant of state.contestants) {
    for (const criterion of dance.criteria) {
      await asJudge('PUT', '/scores', { contestantId: contestant.id, criterionId: criterion.id, score: 10 });
    }
  }
  await asJudge('POST', `/categories/${dance.id}/submit`, {});
  assert.equal((await asPhone(token, 'POST', '/scan', { categoryId: dance.id, image })).status, 409);

  await call('POST', '/api/admin/scoresheets/reopen', { body: { judgeId: judge.id, categoryId: dance.id } });
  await call('PUT', `/api/admin/judges/${judge.id}`, { body: { name: judge.name, categoryIds: state.categories.map((category) => category.id) } });
  assert.equal((await asPhone(token, 'POST', '/scan', { categoryId: dance.id, image: 'not a photo' })).status, 400);
  assert.equal((await asPhone(token, 'POST', '/scan', { categoryId: dance.id, image: `data:image/jpeg;base64,${'A'.repeat(3 * 1024 * 1024)}` })).status, 200);
});

test('a new link replaces the old phone, and the link ends with the judge\'s session', async () => {
  const first = await linkPhone();
  const second = await linkPhone();
  assert.equal((await asPhone(first, 'GET', '/me')).status, 401);
  assert.equal((await asPhone(second, 'GET', '/me')).status, 200);

  // An unused code stops working when a new one is shown.
  const old = (await asJudge('POST', '/phone/link')).body.code;
  await asJudge('POST', '/phone/link');
  assert.equal((await call('POST', '/api/snap/link', { body: { code: old }, from: PHONE })).status, 401);

  // The judge unlinks from their sheet.
  await asJudge('DELETE', '/phone');
  assert.equal((await asPhone(second, 'GET', '/me')).status, 401);

  // The tabulator disconnects the judge: the phone goes with the session.
  const third = await linkPhone();
  await call('POST', `/api/admin/judges/${judge.id}/disconnect`);
  assert.equal((await asPhone(third, 'GET', '/me')).status, 401);
  assert.equal((await call('GET', '/api/admin/state')).body.judges[0].phone_linked, false);

  // A code shown before the session ended is no good either.
  session = (await call('POST', '/api/judge/login', { body: { judgeId: judge.id, accessCode: judge.access_code }, from: LAPTOP })).body.token;
  const stale = (await asJudge('POST', '/phone/link')).body.code;
  await asJudge('POST', '/logout', {});
  assert.equal((await call('POST', '/api/snap/link', { body: { code: stale }, from: PHONE })).status, 401);
});
