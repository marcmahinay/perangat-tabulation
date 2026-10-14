'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { HttpError } = require('../errors');
const v = require('../validate');
const { computeDeductionCharge } = require('../scoring');
const { listCategories, listCriteria, buildResults, categoryResults, parseCategory } = require('../results');
const { randomAccessCode } = require('../seed');
const { normalizeMac } = require('../devices');
const { encoderAccessCode } = require('./encode');

const SETTING_KEYS = ['event_name', 'event_subtitle', 'event_venue', 'event_date', 'tabulator_name'];
const RANKING_METHODS = ['average', 'rank_sum'];
const UNITS = ['flat', 'per_minute', 'per_started_minute'];

const blank = (value) => value == null || value === '';

/** Tabulator-only endpoints. index.js restricts this router to the host computer. */
module.exports = function adminRoutes({ db, hub, serverInfo, guard, scanKey }) {
  const router = express.Router();

  const notify = (type, extra = {}) => hub.broadcast({ type, ...extra });

  function find(table, id, label) {
    const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (!row) throw new HttpError(404, `${label} not found.`);
    return row;
  }

  function nextNumber(table, column) {
    return db.get(`SELECT COALESCE(MAX(${column}), 0) + 1 AS next FROM ${table}`).next;
  }

  /** The smallest number not in use, so deleting Judge 2 and adding a judge gives a new Judge 2. */
  function lowestFreeNumber(table, column) {
    const used = new Set(db.all(`SELECT ${column} AS number FROM ${table}`).map((row) => row.number));
    let number = 1;
    while (used.has(number)) number += 1;
    return number;
  }

  /** The judge who chairs the board of judges, or null. A stale setting (the judge was deleted) counts as none. */
  function chairmanId() {
    const row = db.get("SELECT value FROM settings WHERE key = 'chairman_judge_id'");
    const id = row ? Number(row.value) : 0;
    return id && db.get('SELECT 1 AS ok FROM judges WHERE id = ?', id) ? id : null;
  }

  function savedScanKey() {
    const row = db.get("SELECT value FROM settings WHERE key = 'anthropic_api_key'");
    return row ? row.value : '';
  }

  function setSetting(key, value) {
    db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key, value,
    );
  }

  function allIds(table) {
    return db.all(`SELECT id FROM ${table}`).map((row) => row.id);
  }

  /** Replaces the category links of one judge or contingent. */
  function setCategoryLinks(table, ownerColumn, ownerId, categoryIds) {
    db.run(`DELETE FROM ${table} WHERE ${ownerColumn} = ?`, ownerId);
    for (const categoryId of categoryIds) {
      db.run(`INSERT INTO ${table} (category_id, ${ownerColumn}) VALUES (?, ?)`, categoryId, ownerId);
    }
  }

  /** A sheet that gains something new to score can no longer count as submitted. */
  function reopenSheets(categoryIds) {
    for (const categoryId of categoryIds) {
      db.run(
        "UPDATE scoresheets SET status = 'draft', submitted_at = NULL WHERE category_id = ? AND status = 'submitted'",
        categoryId,
      );
    }
  }

  function categoryIdsFrom(body) {
    return blank(body.categoryIds) ? allIds('categories') : v.idList(body.categoryIds, 'Categories');
  }

  function buildState() {
    const linksByOwner = (table, ownerColumn) => {
      const map = new Map();
      for (const link of db.all(`SELECT category_id, ${ownerColumn} AS owner FROM ${table}`)) {
        if (!map.has(link.owner)) map.set(link.owner, []);
        map.get(link.owner).push(link.category_id);
      }
      return map;
    };
    const judgeLinks = linksByOwner('category_judges', 'judge_id');
    const contestantLinks = linksByOwner('category_contestants', 'contestant_id');
    // The device each judge is signed in on, whether or not it is connected right now.
    const sessions = new Map(
      db.all('SELECT judge_id, ip, mac, created_at FROM judge_sessions')
        .map((session) => [session.judge_id, { ip: session.ip, mac: session.mac, since: session.created_at }]),
    );
    const chairman = chairmanId();
    const encoderJudges = new Map();
    for (const link of db.all('SELECT encoder_id, judge_id FROM encoder_judges')) {
      if (!encoderJudges.has(link.encoder_id)) encoderJudges.set(link.encoder_id, []);
      encoderJudges.get(link.encoder_id).push(link.judge_id);
    }

    return {
      // The Claude API key is kept out of every response.
      settings: Object.fromEntries(db.all("SELECT key, value FROM settings WHERE key <> 'anthropic_api_key'").map((row) => [row.key, row.value])),
      server: { port: serverInfo.port, urls: serverInfo.urls(), dbPath: serverInfo.dbPath },
      deviceLock: guard.locked(),
      blockedDevices: guard.blocked(),
      encoders: {
        accessCode: encoderAccessCode(db),
        devices: db.all(
          `SELECT id, name, pairing_code, status, ip, mac, created_at, paired_at
             FROM encoder_sessions
            ORDER BY status = 'paired', created_at`,
        ).map((device) => ({ ...device, judgeIds: encoderJudges.get(device.id) || [] })),
      },
      // The key itself never leaves the server; the console only learns whether one is set.
      scan: { ready: Boolean(scanKey()), fromEnvironment: Boolean(process.env.ANTHROPIC_API_KEY) && !savedScanKey() },
      chairmanJudgeId: chairman,
      judges: db.all('SELECT id, judge_no, name, access_code, device_mac FROM judges ORDER BY judge_no')
        .map((judge) => ({
          ...judge,
          is_chairman: judge.id === chairman,
          categoryIds: judgeLinks.get(judge.id) || [],
          session: sessions.get(judge.id) || null,
        })),
      contestants: db.all('SELECT id, contestant_no, name FROM contestants ORDER BY contestant_no')
        .map((contestant) => ({ ...contestant, categoryIds: contestantLinks.get(contestant.id) || [] })),
      categories: listCategories(db).map((category) => ({ ...category, criteria: listCriteria(db, category.id) })),
      deductionTypes: db.all('SELECT * FROM deduction_types ORDER BY sort_order, id'),
      deductions: db.all('SELECT * FROM deductions ORDER BY id'),
      onlineJudgeIds: hub.onlineJudgeIds(),
    };
  }

  router.get('/state', (req, res) => res.json(buildState()));

  router.get('/results', (req, res) => {
    res.json({ categories: buildResults(db), onlineJudgeIds: hub.onlineJudgeIds() });
  });

  router.put('/settings', (req, res) => {
    db.tx(() => {
      for (const key of SETTING_KEYS) {
        if (req.body[key] === undefined) continue;
        setSetting(key, v.text(req.body[key], key, { max: 200, required: key === 'event_name' }));
      }
    });
    notify('config');
    res.json({ ok: true });
  });

  // ---- Judges ---------------------------------------------------------------

  function judgeFields(body, existing) {
    let accessCode;
    if (body.new_code === true) accessCode = randomAccessCode();
    else if (blank(body.access_code)) accessCode = existing ? existing.access_code : randomAccessCode();
    else accessCode = v.text(body.access_code, 'Access code', { max: 12 });
    if (!/^[A-Za-z0-9]{4,12}$/.test(accessCode)) {
      throw new HttpError(400, 'Access code must be 4 to 12 letters or digits.');
    }

    // Left out = keep the registered device; blank = any device.
    let deviceMac = existing ? existing.device_mac : null;
    if (body.device_mac !== undefined) {
      deviceMac = blank(body.device_mac) ? null : normalizeMac(body.device_mac);
      if (!blank(body.device_mac) && !deviceMac) {
        throw new HttpError(400, 'Enter the MAC address as six pairs of letters and digits, for example A4:83:E7:12:34:56.');
      }
    }
    if (deviceMac) {
      const owner = db.get('SELECT id, judge_no FROM judges WHERE device_mac = ?', deviceMac);
      if (owner && (!existing || owner.id !== existing.id)) {
        throw new HttpError(409, `That device is already registered to Judge ${owner.judge_no}.`);
      }
    }

    return {
      name: v.text(body.name, 'Judge name', { max: 120 }),
      judge_no: blank(body.judge_no)
        ? (existing ? existing.judge_no : lowestFreeNumber('judges', 'judge_no'))
        : v.number(body.judge_no, 'Judge number', { integer: true, min: 1, max: 999 }),
      access_code: accessCode,
      device_mac: deviceMac,
    };
  }

  router.post('/judges', (req, res) => {
    const fields = judgeFields(req.body);
    const categoryIds = categoryIdsFrom(req.body);
    const id = db.tx(() => {
      const { lastInsertRowid } = db.run(
        'INSERT INTO judges (judge_no, name, access_code, device_mac) VALUES (?, ?, ?, ?)',
        fields.judge_no, fields.name, fields.access_code, fields.device_mac,
      );
      setCategoryLinks('category_judges', 'judge_id', lastInsertRowid, categoryIds);
      return lastInsertRowid;
    });
    notify('config');
    res.status(201).json({ id });
  });

  router.put('/judges/:id', (req, res) => {
    const judge = find('judges', v.id(req.params.id), 'Judge');
    const fields = judgeFields(req.body, judge);
    db.tx(() => {
      db.run(
        'UPDATE judges SET judge_no = ?, name = ?, access_code = ?, device_mac = ? WHERE id = ?',
        fields.judge_no, fields.name, fields.access_code, fields.device_mac, judge.id,
      );
      if (!blank(req.body.categoryIds)) {
        setCategoryLinks('category_judges', 'judge_id', judge.id, v.idList(req.body.categoryIds, 'Categories'));
      }
    });
    // A changed code must lock out whoever was signed in with the old one.
    if (fields.access_code !== judge.access_code) {
      guard.signOut(judge.id, 'Your access code was changed. Ask the tabulator for the new one.');
    }
    guard.enforce();
    notify('config');
    res.json({ ok: true });
  });

  router.delete('/judges/:id', (req, res) => {
    const judge = find('judges', v.id(req.params.id), 'Judge');
    db.tx(() => {
      if (chairmanId() === judge.id) setSetting('chairman_judge_id', '');
      db.run('DELETE FROM judges WHERE id = ?', judge.id);
    });
    hub.disconnectJudge(judge.id, 'This judge was removed by the tabulator.');
    notify('config');
    res.json({ ok: true });
  });

  // Who signs the overall results: the judge who chairs the board of judges, and the tabulator.
  router.put('/signatories', (req, res) => {
    let chairman = null;
    if (!blank(req.body.chairmanJudgeId)) {
      chairman = find('judges', v.id(req.body.chairmanJudgeId, 'Chairman'), 'Judge').id;
    }
    const tabulator = v.text(req.body.tabulatorName, 'Head of Tabulation Team', { max: 200, required: false });
    db.tx(() => {
      setSetting('chairman_judge_id', chairman == null ? '' : String(chairman));
      setSetting('tabulator_name', tabulator);
    });
    notify('config');
    res.json({ ok: true });
  });

  // ---- Encoders: the tabulating team's devices --------------------------------

  const tellEncoders = () => hub.broadcast({ type: 'encoders' }, { roles: ['admin'] });

  /** Replaces the judges an encoder device may enter sheets for. */
  function setEncoderJudges(deviceId, body) {
    const judgeIds = blank(body.judgeIds) ? [] : v.idList(body.judgeIds, 'Judges');
    for (const judgeId of judgeIds) find('judges', judgeId, 'Judge');
    db.run('DELETE FROM encoder_judges WHERE encoder_id = ?', deviceId);
    for (const judgeId of judgeIds) db.run('INSERT INTO encoder_judges (encoder_id, judge_id) VALUES (?, ?)', deviceId, judgeId);
  }

  router.post('/encoders/:id/approve', (req, res) => {
    const device = find('encoder_sessions', v.id(req.params.id), 'Encoder device');
    db.tx(() => {
      db.run("UPDATE encoder_sessions SET status = 'paired', paired_at = datetime('now') WHERE id = ?", device.id);
      if (req.body.judgeIds !== undefined) setEncoderJudges(device.id, req.body);
    });
    tellEncoders();
    res.json({ ok: true });
  });

  router.put('/encoders/:id/judges', (req, res) => {
    const device = find('encoder_sessions', v.id(req.params.id), 'Encoder device');
    db.tx(() => setEncoderJudges(device.id, req.body));
    tellEncoders();
    res.json({ ok: true });
  });

  // Turns down a pairing request, or unpairs a device that was approved.
  router.delete('/encoders/:id', (req, res) => {
    const device = find('encoder_sessions', v.id(req.params.id), 'Encoder device');
    db.run('DELETE FROM encoder_sessions WHERE id = ?', device.id);
    tellEncoders();
    res.json({ ok: true });
  });

  // A new team code stops new pairings with the old one; devices already paired stay paired.
  router.post('/encoder-code', (req, res) => {
    setSetting('encoder_access_code', randomAccessCode());
    tellEncoders();
    res.json({ ok: true });
  });

  router.put('/scan-key', (req, res) => {
    const key = v.text(req.body.apiKey, 'API key', { max: 300, required: false });
    if (key && !/^sk-ant-[A-Za-z0-9_-]+$/.test(key)) {
      throw new HttpError(400, 'That does not look like a Claude API key. It starts with sk-ant-.');
    }
    setSetting('anthropic_api_key', key);
    notify('config');
    res.json({ ok: true, ready: Boolean(scanKey()) });
  });

  // Ends a judge's session, for when the wrong person or the wrong device is signed in.
  router.post('/judges/:id/disconnect', (req, res) => {
    const judge = find('judges', v.id(req.params.id), 'Judge');
    guard.signOut(judge.id, 'The tabulator disconnected this device. Sign in again if this is your scoresheet.');
    res.json({ ok: true });
  });

  // With the lock on, only a judge's registered device can open the judge pages.
  router.put('/device-lock', (req, res) => {
    setSetting('device_lock', req.body.enabled === true ? '1' : '0');
    guard.enforce();
    notify('config');
    res.json({ ok: true, enabled: guard.locked() });
  });

  // ---- Contingents ----------------------------------------------------------

  function contestantFields(body, existing) {
    return {
      name: v.text(body.name, 'Contingent name', { max: 160 }),
      contestant_no: blank(body.contestant_no)
        ? (existing ? existing.contestant_no : nextNumber('contestants', 'contestant_no'))
        : v.number(body.contestant_no, 'Contingent number', { integer: true, min: 1, max: 999 }),
    };
  }

  router.post('/contestants', (req, res) => {
    const fields = contestantFields(req.body);
    const categoryIds = categoryIdsFrom(req.body);
    const id = db.tx(() => {
      const { lastInsertRowid } = db.run(
        'INSERT INTO contestants (contestant_no, name) VALUES (?, ?)',
        fields.contestant_no, fields.name,
      );
      setCategoryLinks('category_contestants', 'contestant_id', lastInsertRowid, categoryIds);
      reopenSheets(categoryIds);
      return lastInsertRowid;
    });
    notify('config');
    res.status(201).json({ id });
  });

  router.put('/contestants/:id', (req, res) => {
    const contestant = find('contestants', v.id(req.params.id), 'Contingent');
    const fields = contestantFields(req.body, contestant);
    db.tx(() => {
      db.run(
        'UPDATE contestants SET contestant_no = ?, name = ? WHERE id = ?',
        fields.contestant_no, fields.name, contestant.id,
      );
      if (!blank(req.body.categoryIds)) {
        const before = new Set(
          db.all('SELECT category_id FROM category_contestants WHERE contestant_id = ?', contestant.id)
            .map((row) => row.category_id),
        );
        const after = v.idList(req.body.categoryIds, 'Categories');
        setCategoryLinks('category_contestants', 'contestant_id', contestant.id, after);
        reopenSheets(after.filter((categoryId) => !before.has(categoryId)));
      }
    });
    notify('config');
    res.json({ ok: true });
  });

  router.delete('/contestants/:id', (req, res) => {
    const contestant = find('contestants', v.id(req.params.id), 'Contingent');
    db.run('DELETE FROM contestants WHERE id = ?', contestant.id);
    notify('config');
    res.json({ ok: true });
  });

  // ---- Categories and criteria ----------------------------------------------

  function categoryFields(body, existing) {
    const titles = blank(body.placement_titles) ? (existing ? existing.placement_titles : []) : body.placement_titles;
    if (!Array.isArray(titles) || titles.length > 20) {
      throw new HttpError(400, 'Award titles must be a list of at most 20 entries.');
    }
    return {
      name: v.text(body.name, 'Category name', { max: 120 }),
      sort_order: blank(body.sort_order)
        ? (existing ? existing.sort_order : nextNumber('categories', 'sort_order'))
        : v.number(body.sort_order, 'Order', { integer: true, min: 0, max: 999 }),
      apply_deductions: body.apply_deductions ? 1 : 0,
      ranking_method: v.oneOf(body.ranking_method || 'rank_sum', 'Ranking method', RANKING_METHODS),
      placement_titles: JSON.stringify(titles.map((title) => v.text(title, 'Award title', { max: 60 }))),
    };
  }

  router.post('/categories', (req, res) => {
    const fields = categoryFields(req.body);
    const id = db.tx(() => {
      const { lastInsertRowid } = db.run(
        `INSERT INTO categories (name, sort_order, apply_deductions, ranking_method, placement_titles)
         VALUES (?, ?, ?, ?, ?)`,
        fields.name, fields.sort_order, fields.apply_deductions, fields.ranking_method, fields.placement_titles,
      );
      // New categories start with every judge and every contingent enrolled.
      for (const judgeId of allIds('judges')) {
        db.run('INSERT INTO category_judges (category_id, judge_id) VALUES (?, ?)', lastInsertRowid, judgeId);
      }
      for (const contestantId of allIds('contestants')) {
        db.run('INSERT INTO category_contestants (category_id, contestant_id) VALUES (?, ?)', lastInsertRowid, contestantId);
      }
      return lastInsertRowid;
    });
    notify('config');
    res.status(201).json({ id });
  });

  router.put('/categories/:id', (req, res) => {
    const category = find('categories', v.id(req.params.id), 'Category');
    const fields = categoryFields(req.body, { ...category, placement_titles: JSON.parse(category.placement_titles) });
    db.run(
      `UPDATE categories
          SET name = ?, sort_order = ?, apply_deductions = ?, ranking_method = ?, placement_titles = ?
        WHERE id = ?`,
      fields.name, fields.sort_order, fields.apply_deductions, fields.ranking_method, fields.placement_titles, category.id,
    );
    notify('config');
    res.json({ ok: true });
  });

  router.delete('/categories/:id', (req, res) => {
    const category = find('categories', v.id(req.params.id), 'Category');
    db.run('DELETE FROM categories WHERE id = ?', category.id);
    notify('config');
    res.json({ ok: true });
  });

  function criterionFields(body, existing, categoryId) {
    return {
      name: v.text(body.name, 'Criterion name', { max: 160 }),
      description: v.text(body.description, 'Description', { max: 1000, required: false }),
      weight: v.number(body.weight, 'Weight', { min: 0.01, max: 100, decimals: 2 }),
      sort_order: blank(body.sort_order)
        ? (existing
          ? existing.sort_order
          : db.get('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM criteria WHERE category_id = ?', categoryId).next)
        : v.number(body.sort_order, 'Order', { integer: true, min: 0, max: 999 }),
    };
  }

  router.post('/criteria', (req, res) => {
    const category = find('categories', v.id(req.body.categoryId, 'Category'), 'Category');
    const fields = criterionFields(req.body, null, category.id);
    const id = db.tx(() => {
      const { lastInsertRowid } = db.run(
        'INSERT INTO criteria (category_id, name, description, weight, sort_order) VALUES (?, ?, ?, ?, ?)',
        category.id, fields.name, fields.description, fields.weight, fields.sort_order,
      );
      reopenSheets([category.id]);
      return lastInsertRowid;
    });
    notify('config');
    res.status(201).json({ id });
  });

  router.put('/criteria/:id', (req, res) => {
    const criterion = find('criteria', v.id(req.params.id), 'Criterion');
    const fields = criterionFields(req.body, criterion, criterion.category_id);
    const highest = db.get('SELECT MAX(score) AS score FROM scores WHERE criterion_id = ?', criterion.id).score;
    if (highest != null && fields.weight < highest) {
      throw new HttpError(409, `A judge has already given ${highest} on this criterion, so its weight cannot go below that.`);
    }
    db.run(
      'UPDATE criteria SET name = ?, description = ?, weight = ?, sort_order = ? WHERE id = ?',
      fields.name, fields.description, fields.weight, fields.sort_order, criterion.id,
    );
    notify('config');
    res.json({ ok: true });
  });

  router.delete('/criteria/:id', (req, res) => {
    const criterion = find('criteria', v.id(req.params.id), 'Criterion');
    db.run('DELETE FROM criteria WHERE id = ?', criterion.id);
    notify('config');
    res.json({ ok: true });
  });

  // ---- Deduction rules and recorded deductions ------------------------------

  function deductionTypeFields(body, existing) {
    return {
      name: v.text(body.name, 'Violation name', { max: 160 }),
      points: v.number(body.points, 'Points', { min: 0.01, max: 100, decimals: 2 }),
      unit: v.oneOf(body.unit || 'flat', 'Charged', UNITS),
      limit_seconds: blank(body.limit_seconds)
        ? null
        : v.number(body.limit_seconds, 'Time limit', { integer: true, min: 1, max: 86400 }),
      notes: v.text(body.notes, 'Notes', { max: 1000, required: false }),
      sort_order: existing ? existing.sort_order : nextNumber('deduction_types', 'sort_order'),
    };
  }

  router.post('/deduction-types', (req, res) => {
    const fields = deductionTypeFields(req.body);
    if (fields.unit !== 'flat' && fields.limit_seconds == null) {
      throw new HttpError(400, 'A per-minute rule needs a time limit.');
    }
    const { lastInsertRowid } = db.run(
      'INSERT INTO deduction_types (name, points, unit, limit_seconds, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      fields.name, fields.points, fields.unit, fields.limit_seconds, fields.notes, fields.sort_order,
    );
    notify('config');
    res.status(201).json({ id: lastInsertRowid });
  });

  router.put('/deduction-types/:id', (req, res) => {
    const type = find('deduction_types', v.id(req.params.id), 'Deduction rule');
    const fields = deductionTypeFields(req.body, type);
    if (fields.unit !== 'flat' && fields.limit_seconds == null) {
      throw new HttpError(400, 'A per-minute rule needs a time limit.');
    }
    db.run(
      'UPDATE deduction_types SET name = ?, points = ?, unit = ?, limit_seconds = ?, notes = ? WHERE id = ?',
      fields.name, fields.points, fields.unit, fields.limit_seconds, fields.notes, type.id,
    );
    notify('config');
    res.json({ ok: true });
  });

  router.delete('/deduction-types/:id', (req, res) => {
    const type = find('deduction_types', v.id(req.params.id), 'Deduction rule');
    if (db.get('SELECT 1 AS used FROM deductions WHERE deduction_type_id = ? LIMIT 1', type.id)) {
      throw new HttpError(409, 'This rule has deductions recorded against it. Remove those deductions first.');
    }
    db.run('DELETE FROM deduction_types WHERE id = ?', type.id);
    notify('config');
    res.json({ ok: true });
  });

  router.post('/deductions', (req, res) => {
    const contestant = find('contestants', v.id(req.body.contestantId, 'Contingent'), 'Contingent');
    const type = find('deduction_types', v.id(req.body.typeId, 'Violation'), 'Deduction rule');

    let measuredSeconds = null;
    let quantity = null;
    if (type.limit_seconds != null && !blank(req.body.measuredSeconds)) {
      measuredSeconds = v.number(req.body.measuredSeconds, 'Measured time', { integer: true, min: 0, max: 86400 });
    } else if (!blank(req.body.quantity)) {
      quantity = v.number(req.body.quantity, 'Quantity', { integer: true, min: 1, max: 100 });
    }

    const charge = computeDeductionCharge(type, { measuredSeconds, quantity });
    if (charge.points <= 0) {
      throw new HttpError(400, 'No deduction applies: the measured time is within what the rule allows.');
    }

    const { lastInsertRowid } = db.run(
      `INSERT INTO deductions (contestant_id, deduction_type_id, measured_seconds, quantity, points, remarks)
       VALUES (?, ?, ?, ?, ?, ?)`,
      contestant.id, type.id, measuredSeconds, charge.quantity, charge.points,
      v.text(req.body.remarks, 'Remarks', { max: 300, required: false }),
    );
    notify('deductions');
    res.status(201).json({ id: lastInsertRowid, ...charge });
  });

  router.delete('/deductions/:id', (req, res) => {
    const deduction = find('deductions', v.id(req.params.id), 'Deduction');
    db.run('DELETE FROM deductions WHERE id = ?', deduction.id);
    notify('deductions');
    res.json({ ok: true });
  });

  // ---- Scoresheet locks and maintenance -------------------------------------

  // ---- The judges' vote on a tie the tie-break could not separate -------------

  router.post('/tie-votes', (req, res) => {
    const category = parseCategory(find('categories', v.id(req.body.categoryId, 'Category'), 'Category'));
    const placing = v.idList(req.body.placing, 'Placing');
    const note = v.text(req.body.note, 'Vote', { max: 120, required: false });

    // The vote must be for a tie that is waiting for one right now.
    const ids = [...placing].sort((a, b) => a - b);
    const pending = categoryResults(db, category).pendingVotes
      .find((level) => level.contestantIds.length === ids.length && [...level.contestantIds].sort((a, b) => a - b).every((id, index) => id === ids[index]));
    if (!pending || placing.length !== req.body.placing.length) {
      throw new HttpError(409, 'Those contingents are not tied and waiting for a vote any more. Reload the results.');
    }
    db.run(
      `INSERT INTO tie_votes (category_id, contestant_ids, placing, note) VALUES (?, ?, ?, ?)
       ON CONFLICT (category_id, contestant_ids) DO UPDATE SET placing = excluded.placing, note = excluded.note, created_at = datetime('now')`,
      category.id, JSON.stringify(ids), JSON.stringify(placing), note,
    );
    notify('sheets', { categoryId: category.id });
    res.status(201).json({ ok: true });
  });

  router.delete('/tie-votes/:id', (req, res) => {
    const vote = find('tie_votes', v.id(req.params.id), 'Vote');
    db.run('DELETE FROM tie_votes WHERE id = ?', vote.id);
    notify('sheets', { categoryId: vote.category_id });
    res.json({ ok: true });
  });

  router.post('/scoresheets/reopen', (req, res) => {
    const judgeId = v.id(req.body.judgeId, 'Judge');
    const categoryId = v.id(req.body.categoryId, 'Category');
    db.run(
      "UPDATE scoresheets SET status = 'draft', submitted_at = NULL WHERE judge_id = ? AND category_id = ?",
      judgeId, categoryId,
    );
    notify('sheets', { judgeId, categoryId });
    res.json({ ok: true });
  });

  router.post('/backup', (req, res) => {
    if (serverInfo.dbPath === ':memory:') throw new HttpError(400, 'An in-memory database cannot be backed up.');
    const directory = path.join(path.dirname(serverInfo.dbPath), 'backups');
    fs.mkdirSync(directory, { recursive: true });
    // Local time, so the file name matches the clock the tabulator is looking at.
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const file = path.join(directory, `tabulation-${stamp}.sqlite`);
    db.raw.prepare('VACUUM INTO ?').run(file);
    res.json({ file });
  });

  // Clears everything the judges and the timekeeper entered, keeping the setup.
  router.post('/reset-scores', (req, res) => {
    if (req.body.confirm !== 'RESET') throw new HttpError(400, 'Type RESET to confirm.');
    db.tx(() => {
      db.run('DELETE FROM scores');
      db.run('DELETE FROM scoresheets');
      db.run('DELETE FROM deductions');
      db.run('DELETE FROM tie_votes');
    });
    notify('config');
    res.json({ ok: true });
  });

  return router;
};
