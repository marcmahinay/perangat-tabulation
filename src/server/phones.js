'use strict';

// A judge's phone, used as a camera for their paper scoresheet.
//
// The judge links it from their own signed-in scoresheet: a six-digit code,
// shown there with a QR code, is valid for ten minutes and once only. The
// linked phone can do one thing, send photos of that judge's sheet; it cannot
// score, submit or even see the sheet. Claude's reading of a photo is held
// here until the judge looks at it on their own device and fills it in. The
// link ends with the judge's session (sign-out, disconnect, new access code).

const crypto = require('node:crypto');

const LINK_TTL_MS = 10 * 60 * 1000;

function createPhones({ db, hub }) {
  const codes = new Map(); // code -> { judgeId, sessionToken, expiresAt }
  const scans = new Map(); // judgeId -> the latest reading, waiting for the judge

  /** A new link code for this judge's session; any earlier one stops working. */
  function newCode(judgeId, sessionToken) {
    const now = Date.now();
    for (const [code, entry] of codes) {
      if (entry.judgeId === judgeId || entry.expiresAt < now) codes.delete(code);
    }
    let code;
    do code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); while (codes.has(code));
    const expiresAt = now + LINK_TTL_MS;
    codes.set(code, { judgeId, sessionToken, expiresAt });
    return { code, expiresAt };
  }

  /**
   * Links the phone that has `code`, replacing any phone linked before.
   * Returns the phone's token, or null when the code is wrong, used or expired,
   * or the judge's session has ended since it was made.
   */
  function redeem(code) {
    const entry = codes.get(code);
    if (!entry || entry.expiresAt < Date.now()) return null;
    codes.delete(code);
    if (!db.get('SELECT 1 AS ok FROM judge_sessions WHERE token = ?', entry.sessionToken)) return null;
    const token = crypto.randomBytes(32).toString('hex');
    db.tx(() => {
      db.run('DELETE FROM judge_phones WHERE judge_id = ?', entry.judgeId);
      db.run('INSERT INTO judge_phones (token, judge_id, session_token) VALUES (?, ?, ?)', token, entry.judgeId, entry.sessionToken);
    });
    hub.sendToJudge(entry.judgeId, { type: 'phone', linked: true });
    return { token, judgeId: entry.judgeId };
  }

  /** The judge a phone token belongs to, or undefined. */
  function judgeForPhone(token) {
    if (!token) return undefined;
    return db.get(
      `SELECT j.id, j.judge_no, j.name, p.created_at AS linked_at
         FROM judge_phones p
         JOIN judges j ON j.id = p.judge_id
        WHERE p.token = ?`,
      token,
    );
  }

  function linkedPhone(judgeId) {
    return db.get('SELECT created_at FROM judge_phones WHERE judge_id = ?', judgeId) || null;
  }

  function unlink(judgeId) {
    db.run('DELETE FROM judge_phones WHERE judge_id = ?', judgeId);
    hub.sendToJudge(judgeId, { type: 'phone', linked: false });
  }

  /** Holds a reading for the judge and tells their device. Returns whether a device of theirs is connected. */
  function deliver(judgeId, scan) {
    scans.set(judgeId, { ...scan, id: crypto.randomUUID(), at: new Date().toISOString() });
    hub.sendToJudge(judgeId, { type: 'scan', categoryId: scan.categoryId });
    return hub.onlineJudgeIds().includes(judgeId);
  }

  return {
    newCode,
    redeem,
    judgeForPhone,
    linkedPhone,
    unlink,
    deliver,
    latest: (judgeId) => scans.get(judgeId) || null,
    dismiss: (judgeId) => scans.delete(judgeId),
  };
}

module.exports = { createPhones, LINK_TTL_MS };
