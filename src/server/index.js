'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Database } = require('./db');
const { HttpError } = require('./errors');
const { createHub } = require('./realtime');
const publicRoutes = require('./routes/public');
const judgeRoutes = require('./routes/judge');
const adminRoutes = require('./routes/admin');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT_ATTEMPTS = 10;

// Adapters created by virtual machines and containers; judges cannot reach the host through them.
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|Loopback|Tailscale|ZeroTier/i;

/** IPv4 addresses other devices on the LAN can use to reach this computer. */
function lanAddresses() {
  const candidates = Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
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

/**
 * The admin console has no password; it is protected by only being reachable
 * from the tabulation computer itself. The Origin check stops a web page open
 * in a browser on that computer from calling the admin API behind its back.
 */
function localOnly(req, res, next) {
  if (!isLoopback(req.socket.remoteAddress)) {
    return next(new HttpError(403, 'The admin console is only available on the tabulation computer.'));
  }
  const { origin, host } = req.headers;
  if (origin) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // An unparseable Origin header is treated as foreign.
    }
    if (originHost !== host) return next(new HttpError(403, 'Cross-site requests are not allowed.'));
  }
  return next();
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
 */
async function startServer({ dbPath, port = 3000, host = '0.0.0.0' }) {
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
        return isLoopback(req.socket.remoteAddress) ? { role: 'admin' } : null;
      }
      const judge = judgeRoutes.judgeForToken(db, url.searchParams.get('token'));
      return judge ? { role: 'judge', judgeId: judge.id } : null;
    },
  });

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // Everything the pages need is served from here; nothing may be loaded from elsewhere.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    req.body = req.body || {};
    next();
  });

  app.use('/api/public', publicRoutes({ db }));
  app.use('/api/judge', judgeRoutes({ db, hub }));
  app.use('/api/admin', localOnly, adminRoutes({ db, hub, serverInfo }));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found.')));

  app.get('/', (req, res) => res.redirect('/judge/'));
  app.use('/shared', express.static(path.join(PUBLIC_DIR, 'shared')));
  app.use('/judge', express.static(path.join(PUBLIC_DIR, 'judge')));
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
    } else if (status >= 500) {
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
