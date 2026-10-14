'use strict';

// Load test: every judge fills in every scoresheet at the same time, over real
// HTTP and against a real database file, while an admin console polls results.
//
//   npm run bench                     7 judges, 20 contingents
//   npm run bench -- 15 60            15 judges, 60 contingents
//
// Uses a throwaway database in the system temp folder; event data is not touched.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { startServer } = require('../src/server');

const judgeCount = Number(process.argv[2]) || 7;
const contingentCount = Number(process.argv[3]) || 20;

let base;

// Kept-alive connections, like a browser. (Node's fetch adds about 15 ms per
// request on Windows, which would hide the server's real response time.)
const agent = new http.Agent({ keepAlive: true });

function call(method, route, body, token) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const text = body === undefined ? null : JSON.stringify(body);
    const request = http.request(base + route, {
      method,
      agent,
      headers: {
        ...(text === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const ms = performance.now() - started;
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (response.statusCode >= 300) {
          reject(new Error(`${method} ${route} -> ${response.statusCode} ${JSON.stringify(payload)}`));
        } else {
          resolve({ payload, ms });
        }
      });
    });
    request.on('error', reject);
    request.end(text === null ? undefined : text);
  });
}

function summarise(label, samples, wallMs) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return {
    what: label,
    requests: sorted.length,
    'per second': wallMs ? Math.round(sorted.length / (wallMs / 1000)) : '',
    'median ms': at(0.5).toFixed(1),
    'p95 ms': at(0.95).toFixed(1),
    'p99 ms': at(0.99).toFixed(1),
    'slowest ms': sorted[sorted.length - 1].toFixed(1),
  };
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'perangat-bench-'));
  const server = await startServer({ dbPath: path.join(directory, 'bench.sqlite'), port: 0, host: '127.0.0.1' });
  // The simulated judges all run on this computer, which the device lock (on by default) refuses.
  await fetch(`${server.localUrl}/api/admin/device-lock`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
  });
  base = server.localUrl;

  try {
    // ---- Setup: the seeded rule book plus the requested panel and field.
    let state = (await call('GET', '/api/admin/state')).payload;
    for (let n = state.judges.length + 1; n <= judgeCount; n += 1) await call('POST', '/api/admin/judges', { name: `Judge ${n}` });
    for (let n = 1; n <= contingentCount; n += 1) await call('POST', '/api/admin/contestants', { name: `Contingent ${n}` });
    state = (await call('GET', '/api/admin/state')).payload;
    const judges = state.judges.slice(0, judgeCount);

    const tokens = [];
    for (const judge of judges) {
      const login = await call('POST', '/api/judge/login', { judgeId: judge.id, accessCode: judge.access_code });
      tokens.push(login.payload.token);
    }

    let liveEvents = 0;
    const adminSocket = new WebSocket(`${base.replace('http', 'ws')}/ws?role=admin`);
    adminSocket.onmessage = () => { liveEvents += 1; };
    await new Promise((resolve, reject) => {
      adminSocket.onopen = resolve;
      adminSocket.onerror = () => reject(new Error('admin socket failed'));
    });

    const cells = state.categories.flatMap((category) =>
      state.contestants.flatMap((contestant) =>
        category.criteria.map((criterion) => ({ contestant, criterion }))));

    // ---- Scoring storm: all judges save cell after cell with no pause between them,
    //      while the admin console re-reads results every 150 ms, as it does on live events.
    const saveTimes = [];
    const pollTimes = [];
    let scoring = true;
    const poller = (async () => {
      while (scoring) {
        pollTimes.push((await call('GET', '/api/admin/results')).ms);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    })();

    const stormStarted = performance.now();
    await Promise.all(tokens.map(async (token, judgeIndex) => {
      for (const [index, cell] of cells.entries()) {
        const score = Math.max(0, cell.criterion.weight - ((index + judgeIndex) % 7) * 0.5);
        const { ms } = await call('PUT', '/api/judge/scores', {
          contestantId: cell.contestant.id, criterionId: cell.criterion.id, score,
        }, token);
        saveTimes.push(ms);
      }
    }));
    const stormMs = performance.now() - stormStarted;
    scoring = false;
    await poller;

    // ---- Reads with every sheet full: the heaviest the computations get.
    const sheetTimes = [];
    const resultTimes = [];
    const stateTimes = [];
    for (let i = 0; i < 30; i += 1) {
      sheetTimes.push((await call('GET', '/api/judge/sheets', undefined, tokens[i % tokens.length])).ms);
      resultTimes.push((await call('GET', '/api/admin/results')).ms);
      stateTimes.push((await call('GET', '/api/admin/state')).ms);
    }

    const submitTimes = [];
    for (const token of tokens) {
      for (const category of state.categories) {
        submitTimes.push((await call('POST', `/api/judge/categories/${category.id}/submit`, {}, token)).ms);
      }
    }
    const results = (await call('GET', '/api/admin/results')).payload;
    await new Promise((resolve) => setTimeout(resolve, 200));
    adminSocket.close();

    console.log(`\n${judges.length} judges x ${contingentCount} contingents x ${state.categories.length} categories`
      + ` = ${cells.length * judges.length} scores\n`);
    console.table([
      summarise('Save one score (all judges at once)', saveTimes, stormMs),
      summarise('Admin results during the storm', pollTimes),
      summarise('Judge loads all scoresheets', sheetTimes),
      summarise('Admin results, sheets full', resultTimes),
      summarise('Admin setup state', stateTimes),
      summarise('Submit a scoresheet', submitTimes),
    ]);

    const allFinal = results.categories.every((category) => category.isFinal);
    const memory = process.memoryUsage();
    console.log(`Live events delivered to the admin socket: ${liveEvents}`
      + ` (${saveTimes.length} saves + ${submitTimes.length} submissions + connection messages)`);
    console.log(`Every category final: ${allFinal}`);
    console.log(`Database file: ${(fs.statSync(path.join(directory, 'bench.sqlite')).size / 1024).toFixed(0)} KB`);
    console.log(`Server + client memory (one process): ${(memory.rss / 1048576).toFixed(0)} MB`);
    if (!allFinal) process.exitCode = 1;
  } finally {
    agent.destroy();
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
