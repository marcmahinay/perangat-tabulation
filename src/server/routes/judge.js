'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { HttpError } = require('../errors');
const v = require('../validate');
const { parseCategory, judgeSheet, judgeSheets } = require('../results');
const { sameDevice } = require('../devices');
const QRCode = require('qrcode');

const MAX_FAILED_LOGINS = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

function sameCode(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Looks up the judge that owns a session token, or undefined. */
function judgeForToken(db, token) {
  if (!token) return undefined;
  return db.get(
    `SELECT j.id, j.judge_no, j.name
       FROM judge_sessions s
       JOIN judges j ON j.id = s.judge_id
      WHERE s.token = ?`,
    token,
  );
}

/** `guard.gate` runs before this router, so every request here carries `req.device`. */
function judgeRoutes({ db, hub, guard, phones, lanUrls }) {
  const router = express.Router();
  const failedLogins = new Map();

  function requireJudge(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const judge = judgeForToken(db, token);
    if (!judge) return next(new HttpError(401, 'Please sign in again.'));
    req.judge = judge;
    req.token = token;
    return next();
  }

  router.post('/login', (req, res) => {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    // Forget expired entries so the table cannot grow without bound.
    for (const [address, entry] of failedLogins) {
      if (entry.resetAt < now) failedLogins.delete(address);
    }
    const attempts = failedLogins.get(ip);
    if (attempts && attempts.count >= MAX_FAILED_LOGINS) {
      throw new HttpError(429, 'Too many incorrect codes. Wait a few minutes or ask the tabulator for help.');
    }

    const judgeId = v.id(req.body.judgeId, 'Judge');
    const accessCode = v.text(req.body.accessCode, 'Access code', { max: 32 });
    const judge = db.get('SELECT id, judge_no, name, access_code, device_mac FROM judges WHERE id = ?', judgeId);

    if (!judge || !sameCode(judge.access_code, accessCode)) {
      failedLogins.set(ip, { count: (attempts ? attempts.count : 0) + 1, resetAt: now + LOGIN_WINDOW_MS });
      throw new HttpError(401, 'Incorrect access code.');
    }
    failedLogins.delete(ip);

    const { device } = req;
    if (guard.locked() && (!device.mac || judge.device_mac !== device.mac)) {
      throw new HttpError(403, `This is not the device registered for Judge ${judge.judge_no}. Ask the tabulator for help.`);
    }

    // One device per judge. The same device may sign in again (a closed private
    // window, another browser); that replaces its earlier session.
    const current = db.get('SELECT ip, mac FROM judge_sessions WHERE judge_id = ?', judge.id);
    if (current && !sameDevice(current, device)) {
      throw new HttpError(409, `Judge ${judge.judge_no} is already signed in on another device. Ask the tabulator to disconnect it first.`);
    }

    const token = crypto.randomBytes(32).toString('hex');
    db.tx(() => {
      db.run('DELETE FROM judge_sessions WHERE judge_id = ?', judge.id);
      db.run('INSERT INTO judge_sessions (token, judge_id, ip, mac) VALUES (?, ?, ?, ?)', token, judge.id, device.ip, device.mac);
    });
    if (current) hub.disconnectJudge(judge.id, 'This scoresheet was signed in to again from another window on this device.');
    guard.tellAdmin();
    res.json({ token, judge: { id: judge.id, judge_no: judge.judge_no, name: judge.name } });
  });

  router.post('/logout', requireJudge, (req, res) => {
    db.run('DELETE FROM judge_sessions WHERE token = ?', req.token);
    guard.tellAdmin();
    res.json({ ok: true });
  });

  // ---- A phone linked to photograph the judge's paper scoresheet ------------

  /** The address a phone opens: the one this device used, unless that is this computer's own name. */
  function phoneAddress(req) {
    const host = String(req.headers.host || '');
    if (!/^[A-Za-z0-9.:[\]-]+$/.test(host)) return null;
    const base = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host) ? lanUrls()[0] : `http://${host}`;
    return base ? `${base}/snap/` : null;
  }

  router.post('/phone/link', requireJudge, async (req, res) => {
    const { code, expiresAt } = phones.newCode(req.judge.id, req.token);
    const address = phoneAddress(req);
    // The code travels after "#", so it never appears in a request line or a log.
    const url = address && `${address}#${code}`;
    const qr = url ? await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : null;
    res.json({ code, expiresAt: new Date(expiresAt).toISOString(), address, url, qr });
  });

  router.get('/phone', requireJudge, (req, res) => {
    res.json({ phone: phones.linkedPhone(req.judge.id) });
  });

  router.delete('/phone', requireJudge, (req, res) => {
    phones.unlink(req.judge.id);
    res.json({ ok: true });
  });

  /** The latest reading of a photo the judge's phone sent, waiting to be looked at. */
  router.get('/scans/latest', requireJudge, (req, res) => {
    const scan = phones.latest(req.judge.id);
    res.json({
      scan: scan && {
        id: scan.id,
        at: scan.at,
        categoryId: scan.categoryId,
        categoryName: scan.categoryName,
        cells: scan.cells,
        warnings: scan.warnings,
        notes: scan.notes,
        heading: scan.heading,
      },
    });
  });

  router.get('/scans/photo', requireJudge, (req, res) => {
    const scan = phones.latest(req.judge.id);
    if (!scan) throw new HttpError(404, 'There is no photo waiting.');
    res.type(scan.photo.mediaType).send(scan.photo.data);
  });

  router.delete('/scans/latest', requireJudge, (req, res) => {
    phones.dismiss(req.judge.id);
    res.json({ ok: true });
  });

  router.get('/sheets', requireJudge, (req, res) => {
    const settings = Object.fromEntries(db.all('SELECT key, value FROM settings').map((row) => [row.key, row.value]));
    res.json({
      event: { name: settings.event_name || '', subtitle: settings.event_subtitle || '' },
      judge: req.judge,
      sheets: judgeSheets(db, req.judge.id),
    });
  });

  /** Looks up a category and checks that this judge scores it and has not submitted it yet. */
  function openCategoryFor(judge, categoryId) {
    const category = db.get(
      `SELECT c.*
         FROM categories c
         JOIN category_judges cj ON cj.category_id = c.id
        WHERE c.id = ? AND cj.judge_id = ?`,
      categoryId, judge.id,
    );
    if (!category) throw new HttpError(403, 'You are not assigned to this category.');

    const sheet = db.get('SELECT status FROM scoresheets WHERE judge_id = ? AND category_id = ?', judge.id, categoryId);
    if (sheet && sheet.status === 'submitted') {
      throw new HttpError(409, 'This scoresheet has been submitted. Ask the tabulator to reopen it if a change is needed.');
    }
    return parseCategory(category);
  }

  // Saves one cell of the scoresheet. A null score clears the cell.
  router.put('/scores', requireJudge, (req, res) => {
    const contestantId = v.id(req.body.contestantId, 'Contingent');
    const criterionId = v.id(req.body.criterionId, 'Criterion');

    const criterion = db.get('SELECT * FROM criteria WHERE id = ?', criterionId);
    if (!criterion) throw new HttpError(404, 'That criterion no longer exists.');
    const category = openCategoryFor(req.judge, criterion.category_id);

    const enrolled = db.get(
      'SELECT 1 AS ok FROM category_contestants WHERE category_id = ? AND contestant_id = ?',
      category.id, contestantId,
    );
    if (!enrolled) throw new HttpError(400, 'That contingent is not competing in this category.');

    if (req.body.score == null || req.body.score === '') {
      db.run(
        'DELETE FROM scores WHERE judge_id = ? AND contestant_id = ? AND criterion_id = ?',
        req.judge.id, contestantId, criterionId,
      );
    } else {
      const score = v.number(req.body.score, 'Score', { min: 0, max: criterion.weight, decimals: 2 });
      // The judge typed it, so it is no longer an encoder's entry.
      db.run(
        `INSERT INTO scores (judge_id, contestant_id, criterion_id, score, entered_by)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (judge_id, contestant_id, criterion_id)
         DO UPDATE SET score = excluded.score, entered_by = NULL, updated_at = datetime('now')`,
        req.judge.id, contestantId, criterionId, score,
      );
    }

    hub.broadcast(
      { type: 'scores', categoryId: category.id, judgeId: req.judge.id, contestantId },
      { roles: ['admin'] },
    );
    res.json({ sheet: judgeSheet(db, category, req.judge.id) });
  });

  // Locks the judge's scoresheet for a category.
  router.post('/categories/:id/submit', requireJudge, (req, res) => {
    const category = openCategoryFor(req.judge, v.id(req.params.id));
    const sheet = judgeSheet(db, category, req.judge.id);

    if (sheet.rows.length === 0) throw new HttpError(400, 'There are no contingents to score yet.');
    const missing = sheet.rows.filter((row) => !row.complete).length;
    if (missing > 0) {
      throw new HttpError(400, `${missing} contingent${missing === 1 ? ' is' : 's are'} not fully scored yet.`);
    }

    db.run(
      `INSERT INTO scoresheets (judge_id, category_id, status, submitted_at)
       VALUES (?, ?, 'submitted', datetime('now'))
       ON CONFLICT (judge_id, category_id)
       DO UPDATE SET status = 'submitted', submitted_at = datetime('now')`,
      req.judge.id, category.id,
    );

    hub.broadcast({ type: 'sheets', categoryId: category.id, judgeId: req.judge.id });
    res.json({ sheet: judgeSheet(db, category, req.judge.id) });
  });

  return router;
}

module.exports = judgeRoutes;
module.exports.judgeForToken = judgeForToken;
