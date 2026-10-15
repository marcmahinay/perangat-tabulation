'use strict';

// /api/snap: a judge's linked phone, used only to photograph their paper scoresheet.
// See phones.js for how a phone is linked and what it may do.

const express = require('express');
const { HttpError } = require('../errors');
const v = require('../validate');
const { parseCategory } = require('../results');
const { interpretScan, parseDataUrl, sheetLayout } = require('../scan');

const MAX_FAILED_LINKS = 10;
const LINK_WINDOW_MS = 5 * 60 * 1000;
// A photo resized on the phone is well under this.
const PHOTO_LIMIT = '10mb';

function snapRoutes({ db, phones, readSheet }) {
  const router = express.Router();
  const failedLinks = new Map();

  function requirePhone(req, res, next) {
    const header = req.headers.authorization || '';
    const judge = phones.judgeForPhone(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (!judge) return next(new HttpError(401, 'This phone is not linked any more. Link it again from your scoresheet.'));
    req.judge = judge;
    return next();
  }

  router.post('/link', (req, res) => {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    for (const [address, entry] of failedLinks) {
      if (entry.resetAt < now) failedLinks.delete(address);
    }
    const attempts = failedLinks.get(ip);
    if (attempts && attempts.count >= MAX_FAILED_LINKS) {
      throw new HttpError(429, 'Too many incorrect codes. Wait a few minutes, then scan the code on your scoresheet again.');
    }
    const code = v.text(req.body.code, 'Link code', { max: 12 });
    const linked = /^\d{6}$/.test(code) ? phones.redeem(code) : null;
    if (!linked) {
      failedLinks.set(ip, { count: (attempts ? attempts.count : 0) + 1, resetAt: now + LINK_WINDOW_MS });
      throw new HttpError(401, 'That code is not valid. Codes work once and for ten minutes; show a new one on your scoresheet.');
    }
    failedLinks.delete(ip);
    res.status(201).json({ token: linked.token });
  });

  /** Who this phone belongs to, and the categories that judge can still send photos for. */
  router.get('/me', requirePhone, (req, res) => {
    const settings = Object.fromEntries(db.all("SELECT key, value FROM settings WHERE key = 'event_name'").map((row) => [row.key, row.value]));
    const categories = db.all(
      `SELECT c.id, c.name, COALESCE(s.status, 'draft') AS status
         FROM categories c
         JOIN category_judges cj ON cj.category_id = c.id AND cj.judge_id = ?
         LEFT JOIN scoresheets s ON s.category_id = c.id AND s.judge_id = cj.judge_id
        ORDER BY c.sort_order, c.id`,
      req.judge.id,
    );
    res.json({
      event: { name: settings.event_name || '' },
      judge: { id: req.judge.id, judge_no: req.judge.judge_no, name: req.judge.name },
      categories,
    });
  });

  // Reads a photo and hands the reading to the judge's own device. Nothing is saved here.
  router.post('/scan', express.json({ limit: PHOTO_LIMIT }), requirePhone, async (req, res) => {
    const categoryId = v.id(req.body.categoryId, 'Category');
    const row = db.get(
      `SELECT c.*
         FROM categories c
         JOIN category_judges cj ON cj.category_id = c.id
        WHERE c.id = ? AND cj.judge_id = ?`,
      categoryId, req.judge.id,
    );
    if (!row) throw new HttpError(404, 'You do not score this category.');
    const lock = db.get('SELECT status FROM scoresheets WHERE judge_id = ? AND category_id = ?', req.judge.id, categoryId);
    if (lock && lock.status === 'submitted') {
      throw new HttpError(409, 'You have already submitted this category. Ask the tabulator to reopen it if a change is needed.');
    }

    const photo = parseDataUrl(req.body.image);
    const layout = sheetLayout(db, parseCategory(row), req.judge.id);
    const reading = interpretScan(await readSheet(req.body.image, layout), layout);
    const delivered = phones.deliver(req.judge.id, {
      categoryId,
      categoryName: row.name,
      ...reading,
      photo: { mediaType: photo.mediaType, data: Buffer.from(photo.data, 'base64') },
    });
    res.json({
      read: reading.cells.filter((cell) => cell.value != null).length,
      flagged: reading.cells.filter((cell) => cell.problem).length,
      warnings: reading.warnings.length,
      delivered,
    });
  });

  router.post('/unlink', requirePhone, (req, res) => {
    phones.unlink(req.judge.id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = snapRoutes;
