'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { HttpError } = require('../errors');
const v = require('../validate');
const { computeDeductionCharge } = require('../scoring');
const { listCategories, listCriteria, buildResults } = require('../results');
const { randomAccessCode } = require('../seed');

const SETTING_KEYS = ['event_name', 'event_subtitle', 'event_venue', 'event_date', 'tabulator_name'];
const RANKING_METHODS = ['average', 'rank_sum'];
const SCOPES = ['per_judge', 'final'];
const UNITS = ['flat', 'per_minute', 'per_started_minute'];

const blank = (value) => value == null || value === '';

/** Tabulator-only endpoints. index.js restricts this router to the host computer. */
module.exports = function adminRoutes({ db, hub, serverInfo }) {
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

    return {
      settings: Object.fromEntries(db.all('SELECT key, value FROM settings').map((row) => [row.key, row.value])),
      server: { port: serverInfo.port, urls: serverInfo.urls(), dbPath: serverInfo.dbPath },
      judges: db.all('SELECT id, judge_no, name, access_code FROM judges ORDER BY judge_no')
        .map((judge) => ({ ...judge, categoryIds: judgeLinks.get(judge.id) || [] })),
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
        const value = v.text(req.body[key], key, { max: 200, required: key === 'event_name' });
        db.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
          key, value,
        );
      }
    });
    notify('config');
    res.json({ ok: true });
  });

  // ---- Judges ---------------------------------------------------------------

  function judgeFields(body, existing) {
    const accessCode = blank(body.access_code)
      ? (existing ? existing.access_code : randomAccessCode())
      : v.text(body.access_code, 'Access code', { max: 12 });
    if (!/^[A-Za-z0-9]{3,12}$/.test(accessCode)) {
      throw new HttpError(400, 'Access code must be 3 to 12 letters or digits.');
    }
    return {
      name: v.text(body.name, 'Judge name', { max: 120 }),
      judge_no: blank(body.judge_no)
        ? (existing ? existing.judge_no : nextNumber('judges', 'judge_no'))
        : v.number(body.judge_no, 'Judge number', { integer: true, min: 1, max: 999 }),
      access_code: accessCode,
    };
  }

  router.post('/judges', (req, res) => {
    const fields = judgeFields(req.body);
    const categoryIds = categoryIdsFrom(req.body);
    const id = db.tx(() => {
      const { lastInsertRowid } = db.run(
        'INSERT INTO judges (judge_no, name, access_code) VALUES (?, ?, ?)',
        fields.judge_no, fields.name, fields.access_code,
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
        'UPDATE judges SET judge_no = ?, name = ?, access_code = ? WHERE id = ?',
        fields.judge_no, fields.name, fields.access_code, judge.id,
      );
      if (!blank(req.body.categoryIds)) {
        setCategoryLinks('category_judges', 'judge_id', judge.id, v.idList(req.body.categoryIds, 'Categories'));
      }
      // A changed code must lock out whoever was signed in with the old one.
      if (fields.access_code !== judge.access_code) {
        db.run('DELETE FROM judge_sessions WHERE judge_id = ?', judge.id);
      }
    });
    notify('config');
    res.json({ ok: true });
  });

  router.delete('/judges/:id', (req, res) => {
    const judge = find('judges', v.id(req.params.id), 'Judge');
    db.run('DELETE FROM judges WHERE id = ?', judge.id);
    notify('config');
    res.json({ ok: true });
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
      scope: v.oneOf(body.scope, 'Applies to', SCOPES),
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
      'INSERT INTO deduction_types (name, points, scope, unit, limit_seconds, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      fields.name, fields.points, fields.scope, fields.unit, fields.limit_seconds, fields.notes, fields.sort_order,
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
      'UPDATE deduction_types SET name = ?, points = ?, scope = ?, unit = ?, limit_seconds = ?, notes = ? WHERE id = ?',
      fields.name, fields.points, fields.scope, fields.unit, fields.limit_seconds, fields.notes, type.id,
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
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
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
    });
    notify('config');
    res.json({ ok: true });
  });

  return router;
};
