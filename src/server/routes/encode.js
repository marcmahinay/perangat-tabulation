'use strict';

// /api/encode: the tabulating team's screen for typing judges' paper scoresheets
// into the system, by hand or from a phone photo.
//
// A device pairs in two steps. It asks with the team access code and gets a
// four-digit pairing code; the tabulator checks that code on the tabulation
// computer and approves it. Until then the device can only ask whether it has
// been approved.

const crypto = require('node:crypto');
const express = require('express');
const { HttpError } = require('../errors');
const v = require('../validate');
const { parseCategory, judgeSheet } = require('../results');
const { randomAccessCode } = require('../seed');
const { interpretScan, sheetLayout } = require('../scan');

const MAX_FAILED_PAIRINGS = 10;
const PAIRING_WINDOW_MS = 5 * 60 * 1000;
const MAX_PENDING = 20;
// A photo resized on the phone is well under this.
const PHOTO_LIMIT = '10mb';

function sameCode(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** The team's access code, created the first time anyone asks for it. */
function encoderAccessCode(db) {
  const row = db.get("SELECT value FROM settings WHERE key = 'encoder_access_code'");
  if (row && row.value) return row.value;
  const code = randomAccessCode();
  db.run("INSERT INTO settings (key, value) VALUES ('encoder_access_code', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", code);
  return code;
}

function encodeRoutes({ db, hub, identify, readSheet }) {
  const router = express.Router();
  const failedPairings = new Map();

  const tellAdmin = () => hub.broadcast({ type: 'encoders' }, { roles: ['admin'] });

  function sessionFor(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    return token ? db.get('SELECT * FROM encoder_sessions WHERE token = ?', token) : undefined;
  }

  function requirePaired(req, res, next) {
    const session = sessionFor(req);
    if (!session) return next(new HttpError(401, 'This device is not paired. Ask the tabulator for the encoder access code.'));
    if (session.status !== 'paired') return next(new HttpError(403, 'Waiting for the tabulator to approve this device.'));
    req.encoder = session;
    return next();
  }

  router.post('/pair', async (req, res) => {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    for (const [address, entry] of failedPairings) {
      if (entry.resetAt < now) failedPairings.delete(address);
    }
    const attempts = failedPairings.get(ip);
    if (attempts && attempts.count >= MAX_FAILED_PAIRINGS) {
      throw new HttpError(429, 'Too many incorrect codes. Wait a few minutes or ask the tabulator for help.');
    }

    const accessCode = v.text(req.body.accessCode, 'Access code', { max: 32 });
    const name = v.text(req.body.name, 'Your name', { max: 80 });
    if (!sameCode(encoderAccessCode(db), accessCode)) {
      failedPairings.set(ip, { count: (attempts ? attempts.count : 0) + 1, resetAt: now + PAIRING_WINDOW_MS });
      throw new HttpError(401, 'Incorrect encoder access code.');
    }
    failedPairings.delete(ip);

    // Requests nobody approved within the hour are dropped, and there is a cap, so the list stays short.
    db.run("DELETE FROM encoder_sessions WHERE status = 'pending' AND created_at < datetime('now', '-1 hour')");
    if (db.get("SELECT COUNT(*) AS count FROM encoder_sessions WHERE status = 'pending'").count >= MAX_PENDING) {
      throw new HttpError(429, 'Too many devices are waiting for approval. Ask the tabulator to clear the list.');
    }

    const device = await identify(req);
    const token = crypto.randomBytes(32).toString('hex');
    const pairingCode = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    db.run(
      'INSERT INTO encoder_sessions (token, name, pairing_code, ip, mac) VALUES (?, ?, ?, ?, ?)',
      token, name, pairingCode, device.ip, device.mac,
    );
    tellAdmin();
    res.status(201).json({ token, pairingCode, status: 'pending', name });
  });

  router.get('/status', (req, res) => {
    const session = sessionFor(req);
    if (!session) throw new HttpError(401, 'This device is not paired.');
    res.json({ status: session.status, name: session.name, pairingCode: session.pairing_code });
  });

  router.post('/unpair', (req, res) => {
    const session = sessionFor(req);
    if (session) db.run('DELETE FROM encoder_sessions WHERE id = ?', session.id);
    tellAdmin();
    res.json({ ok: true });
  });

  /** The judges this device may encode for, as a Set of ids. */
  function assignedJudges(encoder) {
    return new Set(db.all('SELECT judge_id FROM encoder_judges WHERE encoder_id = ?', encoder.id).map((row) => row.judge_id));
  }

  /** What the screen needs to offer: the judges assigned to this device, and the categories they score. */
  router.get('/setup', requirePaired, (req, res) => {
    const assigned = assignedJudges(req.encoder);
    const settings = Object.fromEntries(db.all('SELECT key, value FROM settings').map((row) => [row.key, row.value]));
    const judgeLinks = new Map();
    for (const link of db.all('SELECT category_id, judge_id FROM category_judges')) {
      if (!judgeLinks.has(link.category_id)) judgeLinks.set(link.category_id, []);
      judgeLinks.get(link.category_id).push(link.judge_id);
    }
    res.json({
      event: { name: settings.event_name || '' },
      encoder: { name: req.encoder.name },
      judges: db.all('SELECT id, judge_no, name FROM judges ORDER BY judge_no').filter((judge) => assigned.has(judge.id)),
      categories: db.all('SELECT id, name FROM categories ORDER BY sort_order, id')
        .map((category) => ({ ...category, judgeIds: (judgeLinks.get(category.id) || []).filter((id) => assigned.has(id)) }))
        .filter((category) => category.judgeIds.length > 0),
    });
  });

  /** The category, checked to exist and to be scored by this judge. */
  function categoryForJudge(categoryId, judgeId) {
    const category = db.get(
      `SELECT c.*
         FROM categories c
         JOIN category_judges cj ON cj.category_id = c.id
        WHERE c.id = ? AND cj.judge_id = ?`,
      categoryId, judgeId,
    );
    if (!category) throw new HttpError(404, 'That judge does not score this category.');
    return parseCategory(category);
  }

  function sheetFor(category, judgeId) {
    const sheet = judgeSheet(db, category, judgeId);
    const judge = db.get('SELECT id, judge_no, name FROM judges WHERE id = ?', judgeId);
    const encoded = db.get(
      `SELECT GROUP_CONCAT(DISTINCT s.entered_by) AS names
         FROM scores s
         JOIN criteria k ON k.id = s.criterion_id
        WHERE s.judge_id = ? AND k.category_id = ? AND s.entered_by IS NOT NULL`,
      judgeId, category.id,
    ).names;
    return { ...sheet, judge, encodedBy: encoded ? encoded.split(',') : [] };
  }

  /** The sheet asked for, checked to be one this device may encode. */
  function sheetParams(req, source) {
    const categoryId = v.id(source.categoryId, 'Category');
    const judgeId = v.id(source.judgeId, 'Judge');
    if (!assignedJudges(req.encoder).has(judgeId)) {
      // 409, not 403: the screen reads 403 as "waiting for approval".
      throw new HttpError(409, 'This judge is not assigned to you. Ask the tabulator to assign the judges whose sheets you enter.');
    }
    return { judgeId, category: categoryForJudge(categoryId, judgeId) };
  }

  function refuseIfSubmitted(judgeId, category) {
    const lock = db.get('SELECT status FROM scoresheets WHERE judge_id = ? AND category_id = ?', judgeId, category.id);
    if (lock && lock.status === 'submitted') {
      throw new HttpError(409, 'This scoresheet has been submitted. Ask the tabulator to reopen it before changing it.');
    }
  }

  router.get('/sheet', requirePaired, (req, res) => {
    const { judgeId, category } = sheetParams(req, req.query);
    res.json({ sheet: sheetFor(category, judgeId) });
  });

  // Saves the cells the encoder changed, all or none.
  router.put('/sheet', requirePaired, (req, res) => {
    const { judgeId, category } = sheetParams(req, req.body);
    refuseIfSubmitted(judgeId, category);
    if (!Array.isArray(req.body.cells) || req.body.cells.length === 0) throw new HttpError(400, 'There are no changes to save.');

    const criteria = new Map(db.all('SELECT id, weight, name FROM criteria WHERE category_id = ?', category.id).map((row) => [row.id, row]));
    const enrolled = new Set(db.all('SELECT contestant_id FROM category_contestants WHERE category_id = ?', category.id).map((row) => row.contestant_id));
    const changes = req.body.cells.map((cell) => {
      const contestantId = v.id(cell.contestantId, 'Contingent');
      const criterion = criteria.get(v.id(cell.criterionId, 'Criterion'));
      if (!criterion) throw new HttpError(400, 'A criterion on this sheet no longer exists. Reload the sheet.');
      if (!enrolled.has(contestantId)) throw new HttpError(400, 'A contingent on this sheet is not in this category any more. Reload the sheet.');
      const score = cell.score == null || cell.score === ''
        ? null
        : v.number(cell.score, `${criterion.name} score`, { min: 0, max: criterion.weight, decimals: 2 });
      return { contestantId, criterionId: criterion.id, score };
    });

    db.tx(() => {
      for (const change of changes) {
        if (change.score == null) {
          db.run('DELETE FROM scores WHERE judge_id = ? AND contestant_id = ? AND criterion_id = ?', judgeId, change.contestantId, change.criterionId);
        } else {
          db.run(
            `INSERT INTO scores (judge_id, contestant_id, criterion_id, score, entered_by)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (judge_id, contestant_id, criterion_id)
             DO UPDATE SET score = excluded.score, entered_by = excluded.entered_by, updated_at = datetime('now')`,
            judgeId, change.contestantId, change.criterionId, change.score, req.encoder.name,
          );
        }
      }
    });
    // "sheets" makes the admin console and the judge's own device reload this sheet.
    hub.broadcast({ type: 'sheets', categoryId: category.id, judgeId });
    res.json({ sheet: sheetFor(category, judgeId) });
  });

  // Marks the judge's sheet as submitted once the signed paper sheet is fully encoded.
  router.post('/sheet/submit', requirePaired, (req, res) => {
    const { judgeId, category } = sheetParams(req, req.body);
    refuseIfSubmitted(judgeId, category);
    const sheet = judgeSheet(db, category, judgeId);
    if (sheet.rows.length === 0) throw new HttpError(400, 'There are no contingents to score yet.');
    const missing = sheet.rows.filter((row) => !row.complete).length;
    if (missing > 0) throw new HttpError(400, `${missing} contingent${missing === 1 ? ' is' : 's are'} not fully scored yet.`);
    db.run(
      `INSERT INTO scoresheets (judge_id, category_id, status, submitted_at)
       VALUES (?, ?, 'submitted', datetime('now'))
       ON CONFLICT (judge_id, category_id)
       DO UPDATE SET status = 'submitted', submitted_at = datetime('now')`,
      judgeId, category.id,
    );
    hub.broadcast({ type: 'sheets', categoryId: category.id, judgeId });
    res.json({ sheet: sheetFor(category, judgeId) });
  });

  // Reads a photo of the paper sheet. Nothing is saved: the screen shows the numbers for checking first.
  router.post('/scan', express.json({ limit: PHOTO_LIMIT }), requirePaired, async (req, res) => {
    const { judgeId, category } = sheetParams(req, req.body);
    const layout = sheetLayout(db, category, judgeId);
    const raw = await readSheet(req.body.image, layout);
    res.json(interpretScan(raw, layout));
  });

  return router;
}

module.exports = encodeRoutes;
module.exports.encoderAccessCode = encoderAccessCode;
