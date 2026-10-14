'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Database } = require('./db');
const { HttpError } = require('./errors');
const { createHub } = require('./realtime');
const { createDeviceLookup, createDeviceGuard, networkInterfaces } = require('./devices');
const publicRoutes = require('./routes/public');
const judgeRoutes = require('./routes/judge');
const adminRoutes = require('./routes/admin');
const encodeRoutes = require('./routes/encode');
const { createSheetReader } = require('./scan');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT_ATTEMPTS = 10;

// Adapters created by virtual machines and containers; judges cannot reach the host through them.
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|Loopback|Tailscale|ZeroTier/i;

/** IPv4 addresses other devices on the LAN can use to reach this computer. */
function lanAddresses() {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses || [])
      .filter((address) => address.family === 'IPv4' && !address.internal)
      .map((address) => ({ name, address: address.address })));
  const physical = candidates.filter((candidate) => !VIRTUAL_ADAPTER.test(candidate.name));
  // If the name filter removed everything, show what there is rather than nothing.
  return (physical.length ? physical : candidates).map((candidate) => candidate.address);
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostOf(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * The admin console has no password; it is protected by only being reachable
 * from the tabulation computer itself. Returns why a request is refused, or
 * null when it may use the admin console.
 *
 *  - The connection must come from this computer.
 *  - The Host header must name this computer. A hostile web page can point its
 *    own domain name at 127.0.0.1 (DNS rebinding) and would otherwise look local.
 *  - A request sent by a page must come from the admin console's own pages, so a
 *    site open in a browser on this computer cannot call the admin API.
 */
function adminAccessProblem(req) {
  if (!isLoopback(req.socket.remoteAddress)) {
    return 'The admin console is only available on the tabulation computer.';
  }
  const { origin, host } = req.headers;
  const target = host ? hostOf(`http://${host}`) : null;
  if (!target || !LOCAL_HOSTNAMES.has(target.hostname)) {
    return 'Open the admin console as http://127.0.0.1 or http://localhost.';
  }
  if (origin) {
    const source = hostOf(origin);
    if (!source || source.host !== target.host) return 'Cross-site requests are not allowed.';
  }
  return null;
}

function localOnly(req, res, next) {
  const problem = adminAccessProblem(req);
  return next(problem ? new HttpError(403, problem) : undefined);
}

function listen(server, port, host, attempts) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE' && attempts > 1) {
        resolve(listen(server, port + 1, host, attempts - 1));
      } else {
        reject(error);
      }
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

/**
 * Opens the database and starts the HTTP + WebSocket server.
 * Binding to 0.0.0.0 makes it reachable from every device on the LAN.
 * `identify(req)` says which device a request comes from; the default reads
 * this computer's neighbour table. `readSheet(image, layout)` reads a photo of
 * a paper scoresheet; the default asks Claude, with the key saved under Encoding.
 */
async function startServer({ dbPath, port = 3000, host = '0.0.0.0', identify = createDeviceLookup(), readSheet = null }) {
  const db = new Database(dbPath);
  const app = express();
  const server = http.createServer(app);

  const serverInfo = {
    port,
    dbPath,
    urls: () => lanAddresses().map((address) => `http://${address}:${serverInfo.port}`),
  };

  const hub = createHub({
    server,
    authenticate(req, url) {
      if (url.searchParams.get('role') === 'admin') {
        return adminAccessProblem(req) ? null : { role: 'admin' };
      }
      const judge = judgeRoutes.judgeForToken(db, url.searchParams.get('token'));
      return judge ? { role: 'judge', judgeId: judge.id } : null;
    },
  });
  const guard = createDeviceGuard({ db, hub, identify });
  // The key can be set in the admin console; the environment variable is the fallback.
  const scanKey = () => {
    const row = db.get("SELECT value FROM settings WHERE key = 'anthropic_api_key'");
    return (row && row.value) || process.env.ANTHROPIC_API_KEY || '';
  };
  const sheetReader = readSheet || createSheetReader({ apiKey: scanKey });

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // Everything the pages need is served from here; nothing may be loaded from elsewhere.
    res.setHeader(
      'Content-Security-Policy',
      // blob: lets the encoder screen show the photo it just took, before it is sent.
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  // Scores and access codes must never be kept in a browser or proxy cache.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Every request body is small, except a photo of a paper scoresheet, which that route parses itself.
  const smallJson = express.json({ limit: '100kb' });
  app.use((req, res, next) => (req.path === '/api/encode/scan' ? next() : smallJson(req, res, next)));
  app.use((req, res, next) => {
    req.body = req.body || {};
    next();
  });

  // Everything a judge device asks for passes the device guard first.
  app.use('/api/public', guard.gate, publicRoutes({ db }));
  app.use('/api/judge', guard.gate, judgeRoutes({ db, hub, guard }));
  app.use('/api/admin', localOnly, adminRoutes({ db, hub, serverInfo, guard, scanKey }));
  // Encoder devices are protected by pairing, not by the judges' device lock.
  app.use('/api/encode', encodeRoutes({ db, hub, identify, readSheet: sheetReader }));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found.')));

  app.get('/', (req, res) => res.redirect('/judge/'));
  app.use('/shared', express.static(path.join(PUBLIC_DIR, 'shared')));
  app.use('/judge', guard.gate, express.static(path.join(PUBLIC_DIR, 'judge')));
  app.use('/encode', express.static(path.join(PUBLIC_DIR, 'encode')));
  app.use('/admin', localOnly, express.static(path.join(PUBLIC_DIR, 'admin')));

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    let status = error.status || error.statusCode || 500;
    let message = error.message;
    if (/constraint failed/i.test(message)) {
      status = 409;
      if (/UNIQUE/.test(message)) message = 'That number or name is already in use.';
      else if (/FOREIGN KEY/.test(message)) message = 'This record is still in use, or refers to something that no longer exists.';
      else message = 'The change conflicts with existing data.';
    } else if (status >= 500 && !(error instanceof HttpError)) {
      // An HttpError's message is written for people (the photo reader being offline, say); anything else is a bug.
      console.error(error);
      message = 'Unexpected server error.';
    }
    if (req.originalUrl.startsWith('/api/')) res.status(status).json({ error: message });
    else res.status(status).type('text/plain').send(message);
  });

  serverInfo.port = await listen(server, port, host, port === 0 ? 1 : PORT_ATTEMPTS);

  return {
    db,
    port: serverInfo.port,
    urls: serverInfo.urls,
    localUrl: `http://127.0.0.1:${serverInfo.port}`,
    close() {
      hub.close();
      server.closeAllConnections();
      return new Promise((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      });
    },
  };
}

module.exports = { startServer, lanAddresses, isLoopback };
