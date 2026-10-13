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
