'use strict';

// Reads the rows a category needs out of SQLite and hands them to scoring.js.

const { computeCategoryResults } = require('./scoring');

function parseCategory(row) {
  let titles = [];
  try {
    titles = JSON.parse(row.placement_titles);
  } catch {
    // A hand-edited database could hold bad JSON; fall back to no titles.
  }
  return { ...row, placement_titles: Array.isArray(titles) ? titles : [] };
}

function listCategories(db) {
  return db.all('SELECT * FROM categories ORDER BY sort_order, id').map(parseCategory);
}

function listCriteria(db, categoryId) {
  return db.all('SELECT * FROM criteria WHERE category_id = ? ORDER BY sort_order, id', categoryId);
}

/** Passing `judgeId` restricts the data to that judge, so one judge never sees another's scores. */
function categoryResults(db, category, { judgeId = null } = {}) {
  const contestants = db.all(
    `SELECT c.id, c.contestant_no, c.name
       FROM contestants c
       JOIN category_contestants cc ON cc.contestant_id = c.id
      WHERE cc.category_id = ?
      ORDER BY c.contestant_no`,
    category.id,
  );

  const judges = db.all(
    `SELECT j.id, j.judge_no, j.name, COALESCE(s.status, 'draft') AS status, s.submitted_at
       FROM judges j
       JOIN category_judges cj ON cj.judge_id = j.id
       LEFT JOIN scoresheets s ON s.judge_id = j.id AND s.category_id = cj.category_id
      WHERE cj.category_id = ?
      ORDER BY j.judge_no`,
    category.id,
  ).filter((judge) => judgeId == null || judge.id === judgeId);

  // A judge's own sheet is recomputed on every score they save, so that path
  // reads only their rows instead of the whole panel's.
  const scores = judgeId == null
    ? db.all(
      `SELECT s.judge_id, s.contestant_id, s.criterion_id, s.score
         FROM scores s
         JOIN criteria k ON k.id = s.criterion_id
        WHERE k.category_id = ?`,
      category.id,
    )
    : db.all(
      `SELECT s.judge_id, s.contestant_id, s.criterion_id, s.score
         FROM scores s
         JOIN criteria k ON k.id = s.criterion_id
        WHERE s.judge_id = ? AND k.category_id = ?`,
      judgeId, category.id,
    );

  const deductions = category.apply_deductions
    ? db.all(
      `SELECT d.contestant_id, d.points, d.remarks, t.name
         FROM deductions d
         JOIN deduction_types t ON t.id = d.deduction_type_id
        ORDER BY d.id`,
    )
    : [];

  return computeCategoryResults({
    category,
    criteria: listCriteria(db, category.id),
    contestants,
    judges,
    scores,
    deductions,
  });
}

function buildResults(db) {
  return listCategories(db).map((category) => categoryResults(db, category));
}

/** One judge's view of one category: their own scores, totals and ranking. */
function judgeSheet(db, category, judgeId) {
  const result = categoryResults(db, category, { judgeId });
  const judge = result.judges[0];
  return {
    category: result.category,
    maxScore: result.maxScore,
    criteria: result.criteria,
    status: judge ? judge.status : 'draft',
    submitted_at: judge ? judge.submitted_at : null,
    rows: result.rows.map((row) => ({
      contestant: row.contestant,
      ...row.judges[judgeId],
      deductions: row.deductions,
    })),
  };
}

function judgeSheets(db, judgeId) {
  const categories = db.all(
    `SELECT c.*
       FROM categories c
       JOIN category_judges cj ON cj.category_id = c.id
      WHERE cj.judge_id = ?
      ORDER BY c.sort_order, c.id`,
    judgeId,
  ).map(parseCategory);
  return categories.map((category) => judgeSheet(db, category, judgeId));
}

module.exports = { parseCategory, listCategories, listCriteria, categoryResults, buildResults, judgeSheet, judgeSheets };
