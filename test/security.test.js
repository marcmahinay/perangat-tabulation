'use strict';

// Attacks the running server the way someone on the event Wi-Fi, or a hostile
// web page open on the tabulation computer, could. Every test here is a door
// that must stay shut.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { startServer } = require('../src/server');

let server;
let state;
let tokens;

/** Raw HTTP request, so headers such as Host can be forged and paths are sent exactly as written. */
function raw(method, path, { headers = {}, body, port = server.port } = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        ...(text === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const responseText = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(responseText);
        } catch {
          // Not every response is JSON.
        }
        resolve({ status: response.statusCode, headers: response.headers, text: responseText, json });
      });
    });
    request.on('error', reject);
    request.end(text === null ? undefined : text);
  });
}

const asJudge = (index) => ({ Authorization: `Bearer ${tokens[index]}` });

/** Resolves 'open', or the HTTP status the handshake was refused with. */
function socketOutcome(query, headers = {}) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?${query}`, { headers });
    socket.on('open', () => {
      socket.close();
      resolve('open');
    });
    socket.on('unexpected-response', (request, response) => resolve(response.statusCode));
    socket.on('error', () => {});
  });
}

async function refreshState() {
  state = (await raw('GET', '/api/admin/state')).json;
}

test.before(async () => {
  server = await startServer({ dbPath: ':memory:', port: 0, host: '127.0.0.1' });
  // These tests sign judges in from this computer, which the device lock (on by default) refuses.
  await raw('PUT', '/api/admin/device-lock', { body: { enabled: false } });
  await raw('POST', '/api/admin/contestants', { body: { name: 'Ozamiz City' } });
  await refreshState();
  tokens = [];
  for (const judge of state.judges) {
    const login = await raw('POST', '/api/judge/login', { body: { judgeId: judge.id, accessCode: judge.access_code } });
    tokens.push(login.json.token);
  }
});

test.after(() => server.close());

// ---- The admin console ------------------------------------------------------

test('admin API refuses a request addressed to another host name (DNS rebinding)', async () => {
  // A hostile page can make its own domain resolve to 127.0.0.1. The connection is then
  // local and same-origin as far as the browser is concerned; only the Host header gives it away.
  for (const host of ['evil.example', `evil.example:${server.port}`, '192.168.1.10:3000']) {
    const response = await raw('GET', '/api/admin/state', { headers: { Host: host } });
    assert.equal(response.status, 403, `Host: ${host}`);
    assert.equal(response.text.includes('access_code'), false);
  }
  const rebound = await raw('POST', '/api/admin/reset-scores', {
    headers: { Host: 'evil.example', Origin: 'http://evil.example' },
    body: { confirm: 'RESET' },
  });
  assert.equal(rebound.status, 403);

  assert.equal((await raw('GET', '/api/admin/state', { headers: { Host: `localhost:${server.port}` } })).status, 200);
});

test('admin API refuses requests made by a page from another site', async () => {
  const response = await raw('POST', '/api/admin/backup', { headers: { Origin: 'http://evil.example' } });
  assert.equal(response.status, 403);
});

test('admin pages are refused for another host name too', async () => {
  assert.equal((await raw('GET', '/admin/', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await raw('GET', '/admin/')).status, 200);
});

test('a judge session gives no access to the admin API', async () => {
  // From another device this is refused outright; this checks the token itself unlocks nothing extra.
  const response = await raw('GET', '/api/admin/state', { headers: { ...asJudge(0), Host: 'evil.example' } });
  assert.equal(response.status, 403);
});

test('the admin socket refuses other sites, and the judge socket needs a real session', async () => {
  // WebSockets are not covered by the browser's same-origin rule, so the server must check.
  assert.equal(await socketOutcome('role=admin', { Origin: 'http://evil.example' }), 401);
  assert.equal(await socketOutcome('role=admin', { Host: 'evil.example' }), 401);
  assert.equal(await socketOutcome('role=admin'), 'open');

  assert.equal(await socketOutcome('token=not-a-real-token'), 401);
  assert.equal(await socketOutcome(''), 401);
  assert.equal(await socketOutcome(`token=${tokens[0]}`), 'open');
});

test('the socket drops a client that sends a large message', async () => {
  const code = await new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${tokens[0]}`);
    socket.on('open', () => socket.send('x'.repeat(64 * 1024)));
    socket.on('close', (closeCode) => resolve(closeCode));
    socket.on('error', () => {});
  });
  // 1009 = "message too big"; 1006 = the server cut the connection without ceremony. Either is a drop.
  assert.ok([1006, 1009].includes(code), `close code ${code}`);
  // The server itself is unharmed and still accepts well-behaved clients.
  assert.equal(await socketOutcome(`token=${tokens[0]}`), 'open');
});

// ---- Judges -----------------------------------------------------------------

test('judge endpoints refuse missing, made-up and signed-out sessions', async () => {
  const cell = { contestantId: state.contestants[0].id, criterionId: state.categories[0].criteria[0].id, score: 30 };
  assert.equal((await raw('GET', '/api/judge/sheets')).status, 401);
  assert.equal((await raw('PUT', '/api/judge/scores', { body: cell })).status, 401);
  assert.equal((await raw('PUT', '/api/judge/scores', { body: cell, headers: { Authorization: 'Bearer 0000' } })).status, 401);

  const judge = state.judges[2];
  const login = await raw('POST', '/api/judge/login', { body: { judgeId: judge.id, accessCode: judge.access_code } });
  const session = { Authorization: `Bearer ${login.json.token}` };
  assert.equal((await raw('GET', '/api/judge/sheets', { headers: session })).status, 200);
  await raw('POST', '/api/judge/logout', { headers: session, body: {} });
  assert.equal((await raw('GET', '/api/judge/sheets', { headers: session })).status, 401);
});

test('changing a judge\'s access code ends every session opened with the old one', async () => {
  const judge = state.judges[1];
  assert.equal((await raw('GET', '/api/judge/sheets', { headers: asJudge(1) })).status, 200);
  await raw('PUT', `/api/admin/judges/${judge.id}`, { body: { name: judge.name, access_code: '777888' } });
  assert.equal((await raw('GET', '/api/judge/sheets', { headers: asJudge(1) })).status, 401);

  const old = await raw('POST', '/api/judge/login', { body: { judgeId: judge.id, accessCode: judge.access_code } });
  assert.equal(old.status, 401);
  const fresh = await raw('POST', '/api/judge/login', { body: { judgeId: judge.id, accessCode: '777888' } });
  assert.equal(fresh.status, 200);
  tokens[1] = fresh.json.token;
});

test('a judge cannot score or submit a category they are not assigned to', async () => {
  const judge = state.judges[1];
  const [dance, music] = state.categories;
  await raw('PUT', `/api/admin/judges/${judge.id}`, { body: { name: judge.name, categoryIds: [dance.id] } });

  const cell = { contestantId: state.contestants[0].id, criterionId: music.criteria[0].id, score: 10 };
  assert.equal((await raw('PUT', '/api/judge/scores', { headers: asJudge(1), body: cell })).status, 403);
  assert.equal((await raw('POST', `/api/judge/categories/${music.id}/submit`, { headers: asJudge(1), body: {} })).status, 403);

  const sheets = (await raw('GET', '/api/judge/sheets', { headers: asJudge(1) })).json.sheets;
  assert.deepEqual(sheets.map((sheet) => sheet.category.name), ['Dance Showdown']);
});

test('a judge only ever writes to their own scoresheet', async () => {
  const cell = { contestantId: state.contestants[0].id, criterionId: state.categories[0].criteria[0].id };
  // Extra fields naming another judge are ignored: the judge is taken from the session alone.
  await raw('PUT', '/api/judge/scores', { headers: asJudge(0), body: { ...cell, score: 31, judgeId: state.judges[1].id, judge_id: state.judges[1].id } });

  const results = (await raw('GET', '/api/admin/results')).json.categories[0].rows[0].judges;
  assert.equal(results[state.judges[0].id].scores[cell.criterionId], 31);
  assert.equal(results[state.judges[1].id].scores[cell.criterionId], undefined);

  const mine = (await raw('GET', '/api/judge/sheets', { headers: asJudge(1) })).text;
  assert.equal(mine.includes('access_code'), false);
  assert.equal(mine.includes('"31"') || mine.includes(':31'), false, 'another judge\'s score leaked');
});

test('scores that are out of range or not numbers are rejected', async () => {
  const cell = { contestantId: state.contestants[0].id, criterionId: state.categories[0].criteria[0].id };
  const bad = [-1, 35.01, 1000, 1.234, 'abc', '1e999', true, [30], { value: 30 }, '30; DROP TABLE scores'];
  for (const score of bad) {
    const response = await raw('PUT', '/api/judge/scores', { headers: asJudge(0), body: { ...cell, score } });
    assert.equal(response.status, 400, `score ${JSON.stringify(score)} -> ${response.text}`);
  }
  const unknown = await raw('PUT', '/api/judge/scores', { headers: asJudge(0), body: { contestantId: 99999, criterionId: cell.criterionId, score: 1 } });
  assert.equal(unknown.status, 400);
  // The good score saved earlier is untouched.
  const sheet = (await raw('GET', '/api/judge/sheets', { headers: asJudge(0) })).json.sheets[0];
  assert.equal(sheet.rows[0].scores[cell.criterionId], 31);
});

// ---- Input handling ---------------------------------------------------------

test('hostile text is stored and returned as plain data', async () => {
  const names = ["Robert'); DROP TABLE scores;--", '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>'];
  for (const name of names) {
    assert.equal((await raw('POST', '/api/admin/contestants', { body: { name } })).status, 201);
  }
  await refreshState();
  assert.deepEqual(state.contestants.slice(-3).map((contestant) => contestant.name), names);

  // The scores table survived, and the API answers with JSON, never HTML.
  const results = await raw('GET', '/api/admin/results');
  assert.equal(results.status, 200);
  assert.match(results.headers['content-type'], /^application\/json/);
  const info = await raw('GET', '/api/public/info');
  assert.match(info.headers['content-type'], /^application\/json/);
});

test('static file paths cannot reach outside the public folders', async () => {
  const attempts = [
    '/shared/../../server/schema.sql',
    '/shared/..%2f..%2fserver%2fschema.sql',
    '/judge/%2e%2e/%2e%2e/server/db.js',
    '/shared/..%5c..%5cserver%5cdb.js',
    '/judge/..%2f..%2f..%2fpackage.json',
    '/shared/%2e%2e%2f%2e%2e%2fmain%2fmain.js',
    '/judge/.%2e/.%2e/.%2e/.gitignore',
  ];
  for (const path of attempts) {
    const response = await raw('GET', path);
    assert.notEqual(response.status, 200, path);
    assert.equal(/CREATE TABLE|require\(|node_modules/.test(response.text), false, path);
  }
});

test('oversized and malformed request bodies are refused cleanly', async () => {
  const huge = await raw('POST', '/api/judge/login', { body: JSON.stringify({ accessCode: 'x'.repeat(200 * 1024) }) });
  assert.equal(huge.status, 413);

  const broken = await raw('POST', '/api/judge/login', { body: '{"judgeId": 1,' });
  assert.equal(broken.status, 400);
  assert.equal(typeof broken.json.error, 'string');
  assert.equal(/at .*\.js:\d+/.test(broken.text), false, 'a stack trace leaked');
});

test('responses carry the hardening headers', async () => {
  const page = await raw('GET', '/judge/');
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['x-powered-by'], undefined);

  const api = await raw('GET', '/api/judge/sheets', { headers: asJudge(0) });
  assert.equal(api.headers['cache-control'], 'no-store');
});

test('generated access codes are six digits', async () => {
  await raw('POST', '/api/admin/judges', { body: { name: 'New Judge' } });
  await refreshState();
  assert.match(state.judges.at(-1).access_code, /^\d{6}$/);
  assert.equal((await raw('POST', '/api/admin/judges', { body: { name: 'Weak', access_code: '12' } })).status, 400);

  // "New code" replaces a judge's code with a fresh six-digit one and ends their session.
  const judge = state.judges[0];
  await raw('PUT', `/api/admin/judges/${judge.id}`, { body: { name: judge.name, new_code: true } });
  await refreshState();
  assert.match(state.judges[0].access_code, /^\d{6}$/);
  assert.notEqual(state.judges[0].access_code, judge.access_code);
  assert.equal((await raw('GET', '/api/judge/sheets', { headers: asJudge(0) })).status, 401);
});

// ---- Guessing access codes --------------------------------------------------

test('repeated wrong access codes lock that device out', async () => {
  // Own server: the lockout would otherwise block the other tests, which share this address.
  const other = await startServer({ dbPath: ':memory:', port: 0, host: '127.0.0.1' });
  try {
    await raw('PUT', '/api/admin/device-lock', { port: other.port, body: { enabled: false } });
    const judge = (await raw('GET', '/api/admin/state', { port: other.port })).json.judges[0];
    const guess = (accessCode) => raw('POST', '/api/judge/login', { port: other.port, body: { judgeId: judge.id, accessCode } });

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      assert.equal((await guess('000000')).status, 401, `attempt ${attempt}`);
    }
    assert.equal((await guess('000000')).status, 429);
    // Even the right code is refused during the lockout, so a lucky guess gains nothing.
    assert.equal((await guess(judge.access_code)).status, 429);
    // Unknown judges are counted the same way and answered the same way as wrong codes.
    assert.equal((await raw('POST', '/api/judge/login', { port: other.port, body: { judgeId: 99999, accessCode: 'x' } })).status, 429);
  } finally {
    await other.close();
  }
});
