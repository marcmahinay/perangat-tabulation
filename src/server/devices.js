'use strict';

// Which device is behind a request, and whether it may use the judge pages.
//
// A browser never sends its MAC address. It is read from this computer's
// neighbour (ARP) table, which holds the MAC of every device on the same
// network segment that has talked to it. A device that reaches this computer
// through a router is not in that table, so it has no MAC here.

const os = require('node:os');
const { execFile } = require('node:child_process');
const { HttpError } = require('./errors');

const TABLE_TTL_MS = 5000;
const MISS_RETRY_MS = 1000;
const BLOCKED_KEPT = 20;
const BLOCKED_NOTICE_MS = 10000;

const NEIGHBOUR_COMMAND = {
  win32: ['arp', ['-a']],
  linux: ['ip', ['neigh']],
}[process.platform] || ['arp', ['-an']];

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
const MAC = /\b([0-9a-f]{1,2}(?:[:-][0-9a-f]{1,2}){5})\b/i;

/**
 * "a4-83-e7-12-34-56", "A4:83:E7:12:34:56", "a483.e712.3456" and "a483e7123456"
 * all become "A4:83:E7:12:34:56". Returns null when the text is not a MAC address.
 */
function normalizeMac(value) {
  const text = String(value == null ? '' : value).trim();
  const parts = text.split(/[:-]/);
  // macOS prints octets without their leading zero (a4:83:e7:1:2:3).
  const hex = parts.length === 6 ? parts.map((part) => part.padStart(2, '0')).join('') : text.replace(/[.\s]/g, '');
  return /^[0-9a-f]{12}$/i.test(hex) ? hex.toUpperCase().match(/../g).join(':') : null;
}

/** Reads `arp -a`, `arp -an` or `ip neigh` output into a Map of IPv4 address -> MAC. */
function parseNeighbours(output) {
  const table = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const ip = IPV4.exec(line);
    const mac = MAC.exec(line);
    const address = mac && normalizeMac(mac[1]);
    if (!ip || !address || address === '00:00:00:00:00:00') continue;
    // Broadcast and multicast entries (FF:FF:..., 01:00:5E:...) are not devices.
    if (parseInt(address.slice(0, 2), 16) & 1) continue;
    table.set(ip[1], address);
  }
  return table;
}

function readNeighbours() {
  return new Promise((resolve) => {
    execFile(NEIGHBOUR_COMMAND[0], NEIGHBOUR_COMMAND[1], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      resolve(error ? new Map() : parseNeighbours(stdout));
    });
  });
}

/** "::ffff:192.168.1.5" -> "192.168.1.5" */
const plainAddress = (address) => String(address || '').replace(/^::ffff:/i, '');

const INTERFACES_TTL_MS = 10000;
let interfaces = null;
let interfacesReadAt = 0;

/**
 * This computer's network adapters. Reading them takes several milliseconds on
 * Windows and blocks the server meanwhile, and every request from a judge's
 * device needs them, so they are read at most every ten seconds.
 */
function networkInterfaces() {
  if (!interfaces || Date.now() - interfacesReadAt > INTERFACES_TTL_MS) {
    interfaces = os.networkInterfaces();
    interfacesReadAt = Date.now();
  }
  return interfaces;
}

/** True for a request made from the tabulation computer itself, by any of its own addresses. */
function isThisComputer(ip) {
  if (ip === '127.0.0.1' || ip === '::1') return true;
  return Object.values(networkInterfaces()).some((addresses) =>
    (addresses || []).some((address) => address.address === ip));
}

/**
 * Returns `identify(req)`, which resolves to { ip, mac, local }. `mac` is null
 * when the device is not in the neighbour table; `local` is true for the
 * tabulation computer itself, which has no entry in its own table.
 */
function createDeviceLookup({ read = readNeighbours } = {}) {
  let table = new Map();
  let readAt = 0;
  let reading = null;

  function refresh() {
    if (!reading) {
      reading = Promise.resolve().then(read).catch(() => new Map()).then((next) => {
        table = next;
        readAt = Date.now();
        reading = null;
      });
    }
    return reading;
  }

  return async function identify(req) {
    const ip = plainAddress(req.socket.remoteAddress);
    if (isThisComputer(ip)) return { ip, mac: null, local: true };
    const age = Date.now() - readAt;
    if (!table.has(ip)) {
      // A device that has just connected may not be in the last reading yet.
      if (age > MISS_RETRY_MS) await refresh();
    } else if (age > TABLE_TTL_MS) {
      // Answer from the last reading and renew it in the background, so saving a score never waits for it.
      refresh();
    }
    return { ip, mac: table.get(ip) || null, local: false };
  };
}

const escapeHtml = (text) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** What a turned-away device is shown instead of the judge scoresheet. */
function refusalPage(message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Device not allowed</title>
<link rel="stylesheet" href="/shared/base.css">
<style>main { max-width: 560px; margin: 14vh auto 0; padding: 28px; } h1 { margin-bottom: 10px; } p { font-size: 1.1rem; }</style>
</head>
<body><main class="card"><h1>This device cannot open the judge scoresheet</h1><p>${escapeHtml(message)}</p></main></body>
</html>`;
}

/** Two sightings of the same device: by MAC when both are known, otherwise by address. */
function sameDevice(a, b) {
  return a.mac && b.mac ? a.mac === b.mac : a.ip === b.ip;
}

/**
 * The rules about judge devices:
 *  - a judge is signed in on one device at a time;
 *  - with the device lock on, only a device registered to a judge may open the
 *    judge pages, and only as that judge. That includes the tabulation computer
 *    itself: the admin console stays open there, but its browser cannot sign in
 *    as a judge. Paper sheets are entered on the encoder screen instead.
 */
function createDeviceGuard({ db, hub, identify }) {
  const blocked = new Map();

  const tellAdmin = () => hub.broadcast({ type: 'sessions' }, { roles: ['admin'] });

  /** On unless the tabulator has turned it off: a new database starts locked. */
  function locked() {
    const row = db.get("SELECT value FROM settings WHERE key = 'device_lock'");
    return !row || row.value !== '0';
  }

  function noteBlocked(device) {
    const key = device.mac || device.ip;
    const seen = blocked.get(key);
    const now = Date.now();
    blocked.delete(key);
    blocked.set(key, { ip: device.ip, mac: device.mac, at: new Date(now).toISOString() });
    while (blocked.size > BLOCKED_KEPT) blocked.delete(blocked.keys().next().value);
    // A refused page keeps asking; tell the admin console about it now and then, not every time.
    if (!seen || now - Date.parse(seen.at) > BLOCKED_NOTICE_MS) tellAdmin();
  }

  /** Why this device may not use the judge pages, or null when it may. */
  function problem(device) {
    if (!locked()) return null;
    if (device.local) {
      return 'The device lock is on, so the judge scoresheet cannot be opened on the tabulation computer. Use a registered judge device, or turn the lock off under Judges.';
    }
    if (!device.mac) {
      return 'This device cannot be identified. Judge devices must be on the same Wi-Fi or LAN as the tabulation computer.';
    }
    if (db.get('SELECT 1 AS ok FROM judges WHERE device_mac = ?', device.mac)) return null;
    return `This device is not registered for judging. Show this to the tabulator: ${device.mac} (${device.ip}).`;
  }

  /** Express middleware for everything a judge device asks for. Sets `req.device`. */
  async function gate(req, res, next) {
    req.device = await identify(req);
    const refusal = problem(req.device);
    if (!refusal) {
      next();
      return;
    }
    if (!req.device.local) noteBlocked(req.device);
    // The API answers in JSON like every other refusal; a page request gets something readable on a tablet.
    if (req.baseUrl.startsWith('/api')) throw new HttpError(403, refusal);
    res.status(403).type('html').send(refusalPage(refusal));
  }

  /** Ends a judge's session and tells the device why. */
  function signOut(judgeId, message) {
    db.run('DELETE FROM judge_sessions WHERE judge_id = ?', judgeId);
    hub.disconnectJudge(judgeId, message);
    tellAdmin();
  }

  /** Ends the sessions the device lock no longer allows. Call after the lock or a registration changes. */
  function enforce() {
    if (!locked()) return;
    const sessions = db.all(
      `SELECT s.judge_id, s.ip, s.mac, j.device_mac
         FROM judge_sessions s
         JOIN judges j ON j.id = s.judge_id`,
    );
    for (const session of sessions) {
      if (session.mac && session.mac === session.device_mac) continue;
      signOut(session.judge_id, 'This device is not registered for this judge. Ask the tabulator for help.');
    }
  }

  return {
    gate,
    locked,
    signOut,
    enforce,
    tellAdmin,
    /** Devices turned away by the lock, most recent first. */
    blocked: () => [...blocked.values()].reverse().filter((device) => problem({ ...device, local: false })),
  };
}

module.exports = { normalizeMac, parseNeighbours, createDeviceLookup, createDeviceGuard, sameDevice, isThisComputer, networkInterfaces };
