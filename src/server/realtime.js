'use strict';

const { WebSocketServer } = require('ws');

const HEARTBEAT_MS = 30000;

/**
 * WebSocket hub. The socket only pushes "something changed" notifications from
 * server to clients; all writes go through the REST API.
 *
 * `authenticate(req, url)` returns { role: 'admin' } or { role: 'judge', judgeId },
 * or null to reject the connection.
 */
function createHub({ server, authenticate }) {
  // Clients never send anything meaningful, so refuse large frames instead of buffering them.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const clients = new Map();

  function send(ws, event) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  }

  /** Sends to everyone, or only to the given roles. */
  function broadcast(event, { roles = null } = {}) {
    for (const [ws, client] of clients) {
      if (!roles || roles.includes(client.role)) send(ws, event);
    }
  }

  function onlineJudgeIds() {
    const ids = new Set();
    for (const client of clients.values()) {
      if (client.role === 'judge') ids.add(client.judgeId);
    }
    return [...ids];
  }

  const announcePresence = () => broadcast({ type: 'presence', onlineJudgeIds: onlineJudgeIds() }, { roles: ['admin'] });

  /** Closes a judge's connections after their session has ended, telling the device why first. */
  function disconnectJudge(judgeId, message) {
    for (const [ws, client] of clients) {
      if (client.role !== 'judge' || client.judgeId !== judgeId) continue;
      send(ws, { type: 'signed_out', message });
      ws.close(4001, 'Signed out');
    }
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const client = url.pathname === '/ws' ? authenticate(req, url) : null;
    if (!client) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, client);
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        clients.delete(ws);
        if (client.role === 'judge') announcePresence();
      });
      send(ws, { type: 'hello', role: client.role });
      if (client.role === 'judge') announcePresence();
    });
  });

  // Drop connections that stopped answering, e.g. a tablet that left Wi-Fi range.
  const heartbeat = setInterval(() => {
    for (const ws of clients.keys()) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function close() {
    clearInterval(heartbeat);
    for (const ws of clients.keys()) ws.terminate();
    wss.close();
  }

  /** Sends to the devices signed in as one judge. */
  function sendToJudge(judgeId, event) {
    for (const [ws, client] of clients) {
      if (client.role === 'judge' && client.judgeId === judgeId) send(ws, event);
    }
  }

  return { broadcast, onlineJudgeIds, disconnectJudge, sendToJudge, close };
}

module.exports = { createHub };
