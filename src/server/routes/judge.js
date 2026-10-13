'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { HttpError } = require('../errors');
const v = require('../validate');
const { parseCategory, judgeSheet, judgeSheets } = require('../results');

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

function judgeRoutes({ db, hub }) {
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
    const judge = db.get('SELECT id, judge_no, name, access_code FROM judges WHERE id = ?', judgeId);

    if (!judge || !sameCode(judge.access_code, accessCode)) {
      failedLogins.set(ip, { count: (attempts ? attempts.count : 0) + 1, resetAt: now + LOGIN_WINDOW_MS });
      throw new HttpError(401, 'Incorrect access code.');
    }

    failedLogins.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    db.run('INSERT INTO judge_sessions (token, judge_id) VALUES (?, ?)', token, judge.id);
    res.json({ token, judge: { id: judge.id, judge_no: judge.judge_no, name: judge.name } });
  });

  router.post('/logout', requireJudge, (req, res) => {
    db.run('DELETE FROM judge_sessions WHERE token = ?', req.token);
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
      db.run(
        `INSERT INTO scores (judge_id, contestant_id, criterion_id, score)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (judge_id, contestant_id, criterion_id)
         DO UPDATE SET score = excluded.score, updated_at = datetime('now')`,
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
