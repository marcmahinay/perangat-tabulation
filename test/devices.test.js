'use strict';

// One device per judge, and the device lock. The server normally names a device
// by looking its address up in this computer's neighbour table; here every
// request says which device it comes from in a header, so one test process can
// play several tablets.

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startServer } = require('../src/server');
const { normalizeMac, parseNeighbours, createDeviceLookup, ownMacs } = require('../src/server/devices');

const TABLET_A = { ip: '10.0.0.11', mac: 'A4:83:E7:00:00:0A' };
const TABLET_B = { ip: '10.0.0.12', mac: 'A4:83:E7:00:00:0B' };
const STRANGER = { ip: '10.0.0.66', mac: 'DE:AD:BE:EF:00:01' };
const ROUTED = { ip: '172.16.5.9', mac: null };

let server;
let judges;

/** No header = the tabulation computer itself. */
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
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Pages and refusals of pages are not JSON.
  }
  return { status: response.status, text, json };
}

const login = (judge, from) => call('POST', '/api/judge/login', { from, body: { judgeId: judge.id, accessCode: judge.access_code } });
const sheets = (token, from) => call('GET', '/api/judge/sheets', { token, from });
const admin = (method, path, body) => call(method, `/api/admin${path}`, { body });

async function refreshJudges() {
  judges = (await admin('GET', '/state')).json.judges;
}

/** Opens a judge socket and resolves { events, closed } once it is up; `closed` resolves when it ends. */
function listen(token) {
  return new Promise((resolve, reject) => {
    const events = [];
    const socket = new WebSocket(`${server.localUrl.replace('http', 'ws')}/ws?token=${token}`);
    const closed = new Promise((done) => socket.on('close', done));
    socket.on('message', (data) => events.push(JSON.parse(data)));
    socket.on('open', () => resolve({ events, closed }));
    socket.on('error', reject);
  });
}

test.before(async () => {
  server = await startServer({ dbPath: ':memory:', port: 0, host: '127.0.0.1', identify });
  await refreshJudges();
});

test('a new database starts with the device lock on, so no device can open the judge pages yet', async () => {
  assert.equal((await admin('GET', '/state')).json.deviceLock, true);
  const refused = await call('GET', '/judge/', { from: TABLET_A });
  assert.equal(refused.status, 403);
  assert.match(refused.text, /not registered for judging/);
  assert.equal((await call('GET', '/judge/')).status, 403, 'not even on the tabulation computer');

  // The devices that tried are listed so the tabulator can register them; the tests below start unlocked.
  assert.deepEqual((await admin('GET', '/state')).json.blockedDevices.map((device) => device.mac), [TABLET_A.mac]);
  assert.deepEqual((await admin('PUT', '/device-lock', { enabled: false })).json, { ok: true, enabled: false });
});

test.after(() => server.close());

// ---- Reading MAC addresses --------------------------------------------------

test('MAC addresses are accepted in every common spelling', () => {
  for (const spelling of ['a4-83-e7-12-34-56', 'A4:83:E7:12:34:56', 'a483.e712.3456', 'a483e7123456', ' a4:83:e7:12:34:56 ']) {
    assert.equal(normalizeMac(spelling), 'A4:83:E7:12:34:56', spelling);
  }
  assert.equal(normalizeMac('a4:83:e7:1:2:3'), 'A4:83:E7:01:02:03');
  for (const junk of ['', null, 'hello', 'a4:83:e7:12:34', 'a4:83:e7:12:34:56:78', 'g4:83:e7:12:34:56', '192.168.1.5']) {
    assert.equal(normalizeMac(junk), null, String(junk));
  }
});

test('the neighbour table is read on Windows, Linux and macOS', () => {
  const windows = [
    '',
    'Interface: 192.168.1.2 --- 0x5',
    '  Internet Address      Physical Address      Type',
    '  192.168.1.1           3c-84-6a-11-22-33     dynamic',
    '  192.168.1.23          a4-83-e7-12-34-56     dynamic',
    '  192.168.1.255         ff-ff-ff-ff-ff-ff     static',
    '  224.0.0.22            01-00-5e-00-00-16     static',
  ].join('\r\n');
  assert.deepEqual([...parseNeighbours(windows)], [
    ['192.168.1.1', '3C:84:6A:11:22:33'],
    ['192.168.1.23', 'A4:83:E7:12:34:56'],
  ]);

  const linux = [
    '192.168.1.23 dev wlan0 lladdr a4:83:e7:12:34:56 REACHABLE',
    '192.168.1.40 dev wlan0  FAILED',
    'fe80::1 dev wlan0 lladdr 3c:84:6a:11:22:33 router STALE',
  ].join('\n');
  assert.deepEqual([...parseNeighbours(linux)], [['192.168.1.23', 'A4:83:E7:12:34:56']]);

  const macos = [
    '? (192.168.1.23) at a4:83:e7:1:2:3 on en0 ifscope [ethernet]',
    '? (192.168.1.40) at (incomplete) on en0 ifscope [ethernet]',
  ].join('\n');
  assert.deepEqual([...parseNeighbours(macos)], [['192.168.1.23', 'A4:83:E7:01:02:03']]);
});

test('a device is looked up by its address; the tabulation computer needs no lookup', async () => {
  let reads = 0;
  const lookup = createDeviceLookup({
    read: async () => {
      reads += 1;
      return new Map([['192.168.1.23', 'A4:83:E7:12:34:56']]);
    },
  });
  const from = (remoteAddress) => lookup({ socket: { remoteAddress } });

  assert.deepEqual(await from('127.0.0.1'), { ip: '127.0.0.1', mac: null, local: true });
  assert.deepEqual(await from('::ffff:127.0.0.1'), { ip: '127.0.0.1', mac: null, local: true });
  assert.equal(reads, 0);
  assert.deepEqual(await from('::ffff:192.168.1.23'), { ip: '192.168.1.23', mac: 'A4:83:E7:12:34:56', local: false });
  // A device reached through a router is not in the table.
  assert.deepEqual(await from('172.16.5.9'), { ip: '172.16.5.9', mac: null, local: false });
  // The table is kept for a few seconds, not read again for every request.
  await from('192.168.1.23');
  assert.equal(reads, 1);
});

// ---- One device per judge ---------------------------------------------------

test('a judge is signed in on one device at a time', async () => {
  const judge = judges[0];
  const first = await login(judge, TABLET_A);
  assert.equal(first.status, 200);

  // The right access code is not enough from a second device.
  const second = await login(judge, TABLET_B);
  assert.equal(second.status, 409);
  assert.match(second.json.error, /already signed in on another device/);
  assert.equal((await sheets(first.json.token, TABLET_A)).status, 200);

  // Other judges are not affected.
  assert.equal((await login(judges[1], TABLET_B)).status, 200);

  await refreshJudges();
  assert.deepEqual({ ip: judges[0].session.ip, mac: judges[0].session.mac }, TABLET_A);
  assert.deepEqual({ ip: judges[1].session.ip, mac: judges[1].session.mac }, TABLET_B);
  assert.equal(judges[2].session, null);
});

test('the same device signing in again replaces its own session', async () => {
  const judge = judges[2];
  const before = await login(judge, STRANGER);
  const socket = await listen(before.json.token);

  // Same MAC from a new address, as after the tablet rejoined the Wi-Fi.
  const again = await login(judge, { ...STRANGER, ip: '10.0.0.67' });
  assert.equal(again.status, 200);
  await socket.closed;
  assert.equal(socket.events.at(-1).type, 'signed_out');
  assert.equal((await sheets(before.json.token, STRANGER)).status, 401);
  assert.equal((await sheets(again.json.token, STRANGER)).status, 200);

  // Signing out frees the judge for another device.
  await call('POST', '/api/judge/logout', { token: again.json.token, from: STRANGER, body: {} });
  await refreshJudges();
  assert.equal(judges[2].session, null);
});

test('the tabulator can disconnect the device signed in as a judge', async () => {
  const judge = judges[2];
  const wrong = await login(judge, STRANGER);
  assert.equal(wrong.status, 200);
  const socket = await listen(wrong.json.token);

  assert.equal((await admin('POST', `/judges/${judge.id}/disconnect`)).status, 200);
  await socket.closed;
  assert.deepEqual(socket.events.at(-1), {
    type: 'signed_out',
    message: 'The tabulator disconnected this device. Sign in again if this is your scoresheet.',
  });
  assert.equal((await sheets(wrong.json.token, STRANGER)).status, 401);
  await refreshJudges();
  assert.equal(judges[2].session, null);

  // The right judge can now sign in on their own device.
  const right = await login(judge, { ip: '10.0.0.13', mac: 'A4:83:E7:00:00:0C' });
  assert.equal(right.status, 200);
  await call('POST', '/api/judge/logout', { token: right.json.token, from: { ip: '10.0.0.13', mac: 'A4:83:E7:00:00:0C' }, body: {} });
});

// ---- The device lock --------------------------------------------------------

test('a device is registered to one judge only, by MAC address', async () => {
  const [one, two] = judges;
  assert.equal((await admin('PUT', `/judges/${one.id}`, { name: one.name, device_mac: 'not a mac' })).status, 400);
  assert.equal((await admin('PUT', `/judges/${one.id}`, { name: one.name, device_mac: 'a4-83-e7-00-00-0a' })).status, 200);

  const taken = await admin('PUT', `/judges/${two.id}`, { name: two.name, device_mac: TABLET_A.mac });
  assert.equal(taken.status, 409);
  assert.match(taken.json.error, /already registered to Judge 1/);

  // Leaving the field out keeps the registration; a blank clears it.
  await admin('PUT', `/judges/${one.id}`, { name: one.name });
  await refreshJudges();
  assert.equal(judges[0].device_mac, TABLET_A.mac);
  assert.equal(judges[0].access_code, one.access_code);
  await admin('PUT', `/judges/${two.id}`, { name: two.name, device_mac: TABLET_B.mac });
  await admin('PUT', `/judges/${two.id}`, { name: two.name, device_mac: '' });
  await refreshJudges();
  assert.equal(judges[1].device_mac, null);
});

test('with the lock off, any device can open the judge pages', async () => {
  for (const device of [TABLET_A, STRANGER, ROUTED]) {
    assert.equal((await call('GET', '/judge/', { from: device })).status, 200, device.ip);
    assert.equal((await call('GET', '/api/public/info', { from: device })).status, 200, device.ip);
  }
  assert.deepEqual((await admin('GET', '/state')).json.blockedDevices, []);
});

test('turning the lock on signs out every device that is not the registered one', async () => {
  // Judge 1 is on tablet A, which is registered. Judge 2 is on tablet B, which is not.
  const two = await login(judges[1], TABLET_B);
  assert.equal(two.status, 200);
  const socket = await listen(two.json.token);

  const locked = await admin('PUT', '/device-lock', { enabled: true });
  assert.deepEqual(locked.json, { ok: true, enabled: true });
  await socket.closed;
  assert.equal(socket.events.at(-1).type, 'signed_out');

  await refreshJudges();
  assert.equal(judges[0].session.mac, TABLET_A.mac);
  assert.equal(judges[1].session, null);
});

test('with the lock on, only registered devices can open the judge pages', async () => {
  // The registered tablet gets in.
  assert.equal((await call('GET', '/judge/', { from: TABLET_A })).status, 200);
  assert.equal((await call('GET', '/api/public/info', { from: TABLET_A })).status, 200);

  // So does no other device, not even the tabulation computer's own browser; its admin console still works.
  const local = await call('GET', '/judge/');
  assert.equal(local.status, 403);
  assert.match(local.text, /this tabulation computer is not registered to a judge/);
  assert.ok(local.text.includes(ownMacs()[0]), 'the refusal names this computer\'s MAC so it can be registered');
  const one = judges[0];
  assert.equal((await login(one)).status, 403, 'the right access code is not enough on the tabulation computer');
  assert.equal((await admin('GET', '/state')).status, 200);
  assert.equal((await admin('GET', '/state')).json.blockedDevices.some((device) => device.ip === '127.0.0.1'), false);

  // Everything else is turned away from the page, its script and the API alike.
  for (const path of ['/judge/', '/judge/judge.js', '/api/public/info', '/api/judge/sheets']) {
    const refused = await call('GET', path, { from: STRANGER });
    assert.equal(refused.status, 403, path);
    assert.match(refused.text, /not registered for judging/);
    assert.ok(refused.text.includes(STRANGER.mac), 'the refusal names the device so the tabulator can register it');
    assert.equal(refused.text.includes('judge_no'), false, 'no judge list is given to a refused device');
  }

  // A device whose MAC cannot be read is refused too, rather than let through.
  const unknown = await call('GET', '/judge/', { from: ROUTED });
  assert.equal(unknown.status, 403);
  assert.match(unknown.text, /cannot be identified/);

  const { blockedDevices } = (await admin('GET', '/state')).json;
  assert.deepEqual(blockedDevices.map((device) => [device.ip, device.mac]), [[ROUTED.ip, null], [STRANGER.ip, STRANGER.mac]]);
});

test('with the lock on, a registered device signs in only as its own judge', async () => {
  const [one, two] = judges;
  // Tablet A knows judge 2's code, but it is judge 1's device.
  await admin('PUT', `/judges/${two.id}`, { name: two.name, device_mac: TABLET_B.mac });
  const swapped = await login(two, TABLET_A);
  assert.equal(swapped.status, 403);
  assert.match(swapped.json.error, /not the device registered for Judge 2/);

  assert.equal((await login(two, TABLET_B)).status, 200);
  assert.equal((await login(one, TABLET_A)).status, 200);

  // A judge with no registered device cannot sign in from anywhere on the network.
  await admin('PUT', `/judges/${two.id}`, { name: two.name, device_mac: '' });
  await refreshJudges();
  assert.equal(judges[1].session, null, 'clearing the registration ends the session opened on it');
  assert.equal((await call('GET', '/judge/', { from: TABLET_B })).status, 403);
});

test('registering a device that was turned away lets it in, and replacing a registration ends the old session', async () => {
  const one = judges[0];
  const old = await login(one, TABLET_A);
  await admin('PUT', `/judges/${one.id}`, { name: one.name, device_mac: STRANGER.mac });

  assert.equal((await sheets(old.json.token, TABLET_A)).status, 403);
  assert.equal((await call('GET', '/judge/', { from: STRANGER })).status, 200);
  assert.equal((await login(one, STRANGER)).status, 200);
  const { blockedDevices } = (await admin('GET', '/state')).json;
  assert.equal(blockedDevices.some((device) => device.mac === STRANGER.mac), false);
});

test('the tabulation computer registered to a judge opens the judge page, and signs in only as that judge', async () => {
  const [, two, three] = judges;
  const thisComputer = ownMacs()[0];
  await admin('PUT', `/judges/${three.id}`, { name: three.name, device_mac: thisComputer });

  assert.equal((await call('GET', '/judge/')).status, 200);
  assert.equal((await login(three)).status, 200);
  const wrongJudge = await login(two);
  assert.equal(wrongJudge.status, 403);
  assert.match(wrongJudge.json.error, /not the device registered for Judge 2/);

  await refreshJudges();
  assert.equal(judges[2].session.mac, thisComputer);
  assert.ok((await admin('GET', '/state')).json.server.macs.includes(thisComputer));

  // Clearing the registration turns it away again and ends its session.
  await admin('PUT', `/judges/${three.id}`, { name: three.name, device_mac: '' });
  assert.equal((await call('GET', '/judge/')).status, 403);
  await refreshJudges();
  assert.equal(judges[2].session, null);
});

test('turning the lock off lets any device open the judge pages again', async () => {
  assert.deepEqual((await admin('PUT', '/device-lock', { enabled: false })).json, { ok: true, enabled: false });
  assert.equal((await call('GET', '/judge/', { from: TABLET_B })).status, 200);
  assert.equal((await login(judges[1], TABLET_B)).status, 200);
});

test('a database from before device sessions is upgraded in place', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const { Database } = require('../src/server/db');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'perangat-'));
  const file = path.join(directory, 'old.sqlite');
  try {
    const created = new Database(file);
    created.close();

    // Put the file back to the shape version 2 left it in, with two sessions for one judge.
    const old = new DatabaseSync(file);
    old.exec('DROP INDEX idx_judge_sessions_judge');
    old.exec('ALTER TABLE judge_sessions DROP COLUMN ip; ALTER TABLE judge_sessions DROP COLUMN mac; ALTER TABLE judges DROP COLUMN device_mac');
    old.exec("INSERT INTO judge_sessions (token, judge_id) VALUES ('first', 1), ('second', 1), ('other', 2)");
    old.exec('PRAGMA user_version = 2');
    old.close();

    const upgraded = new Database(file);
    assert.deepEqual(
      upgraded.all('SELECT token, judge_id, ip, mac FROM judge_sessions ORDER BY judge_id').map((row) => ({ ...row })),
      [{ token: 'second', judge_id: 1, ip: null, mac: null }, { token: 'other', judge_id: 2, ip: null, mac: null }],
    );
    assert.equal(upgraded.get('SELECT device_mac FROM judges WHERE id = 1').device_mac, null);
    assert.throws(() => upgraded.run("INSERT INTO judge_sessions (token, judge_id) VALUES ('third', 1)"), /UNIQUE/);
    upgraded.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
