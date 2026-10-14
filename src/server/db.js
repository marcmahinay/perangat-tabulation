'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { seedDatabase } = require('./seed');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

// One-off changes to databases created by an earlier version. Entry N brings a
// database from PRAGMA user_version N to N + 1. Append only; never edit an entry.
const MIGRATIONS = [
  // The festival ranks by the sum of the judges' ranks and awards down to 2nd
  // runner up. Databases seeded before that was known still hold the first guess.
  (db) => {
    db.run("UPDATE categories SET ranking_method = 'rank_sum' WHERE ranking_method = 'average'");
    db.run(
      "UPDATE categories SET placement_titles = ? WHERE name = 'Dance Showdown' AND placement_titles = ?",
      JSON.stringify(['CHAMPION', '1ST RUNNER UP', '2ND RUNNER UP']),
      JSON.stringify(['CHAMPION', '1ST RUNNER UP', '2ND RUNNER UP', '3RD RUNNER UP', '4TH RUNNER UP']),
    );
  },
  // Deduction rules used to say whether they came off each judge's score or
  // off the averaged final score. Every deduction now comes off each judge's
  // raw score, so the column that held that choice is dropped.
  (db) => {
    const columns = db.raw.prepare('PRAGMA table_info(deduction_types)').all();
    if (columns.some((column) => column.name === 'scope')) {
      db.raw.exec('ALTER TABLE deduction_types DROP COLUMN scope');
    }
  },
  // One device per judge. A session now records the device it was opened on,
  // a judge can be tied to one registered device, and a judge has at most one
  // session, so the extra sessions an older version allowed are removed.
  (db) => {
    const hasColumn = (table, name) =>
      db.raw.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name);
    if (!hasColumn('judges', 'device_mac')) db.raw.exec('ALTER TABLE judges ADD COLUMN device_mac TEXT');
    if (!hasColumn('judge_sessions', 'ip')) db.raw.exec('ALTER TABLE judge_sessions ADD COLUMN ip TEXT');
    if (!hasColumn('judge_sessions', 'mac')) db.raw.exec('ALTER TABLE judge_sessions ADD COLUMN mac TEXT');
    db.raw.exec('DELETE FROM judge_sessions WHERE rowid NOT IN (SELECT MAX(rowid) FROM judge_sessions GROUP BY judge_id)');
    db.raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_judge_sessions_judge ON judge_sessions(judge_id)');
  },
  // Scores can be encoded from paper by the tabulating team; record who typed each one.
  (db) => {
    const columns = db.raw.prepare('PRAGMA table_info(scores)').all();
    if (!columns.some((column) => column.name === 'entered_by')) db.raw.exec('ALTER TABLE scores ADD COLUMN entered_by TEXT');
  },
];

/** Thin synchronous wrapper around node:sqlite with cached statements. */
class Database {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.statements = new Map();
    // synchronous = FULL flushes every save to disk before the judge is told it
    // is saved (about 3 ms each). NORMAL would be far faster but could lose the
    // last few scores in a power cut, which matters more here than throughput.
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.raw.exec(SCHEMA);
    seedDatabase(this);
    this.migrate();
  }

  migrate() {
    const current = this.raw.prepare('PRAGMA user_version').get().user_version;
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      this.tx(() => {
        MIGRATIONS[version](this);
        this.raw.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params);
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...params);
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...params);
  }

  /** Runs `fn` inside a transaction; rolls back if it throws. Do not nest. */
  tx(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.statements.clear();
    this.raw.close();
  }
}

module.exports = { Database };
