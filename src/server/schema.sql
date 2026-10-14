-- Perangat Festival tabulation schema.
-- Every statement is idempotent so the file can be executed on each startup.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS judges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  judge_no    INTEGER NOT NULL UNIQUE,            -- "Judge 1", "Judge 2", ...
  name        TEXT    NOT NULL,
  access_code TEXT    NOT NULL,                   -- handed to the judge by the tabulator
  device_mac  TEXT,                               -- "A4:83:E7:12:34:56": the one device this judge may use while the device lock is on
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- A judge is signed in on one device at a time: db.js adds a unique index on
-- judge_id once it has removed the duplicates an older version allowed.
-- `ip` and `mac` identify the device the session was opened on.
CREATE TABLE IF NOT EXISTS judge_sessions (
  token      TEXT    PRIMARY KEY,
  judge_id   INTEGER NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  ip         TEXT,
  mac        TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One row per judged award, e.g. Dance Showdown, Best Music, Festival Queen.
CREATE TABLE IF NOT EXISTS categories (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL UNIQUE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  apply_deductions INTEGER NOT NULL DEFAULT 1 CHECK (apply_deductions IN (0, 1)),
  ranking_method   TEXT    NOT NULL DEFAULT 'rank_sum'
                   CHECK (ranking_method IN ('average', 'rank_sum')),
  placement_titles TEXT    NOT NULL DEFAULT '[]'  -- JSON array, index 0 = rank 1
);

-- One row per line of a criteria table. `weight` is both the percentage and
-- the maximum points a judge can give (35% => scored out of 35).
CREATE TABLE IF NOT EXISTS criteria (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  weight      REAL    NOT NULL CHECK (weight > 0),
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contestants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contestant_no INTEGER NOT NULL UNIQUE,          -- order of performance
  name          TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Which contingents compete in, and which judges score, each category.
CREATE TABLE IF NOT EXISTS category_contestants (
  category_id   INTEGER NOT NULL REFERENCES categories(id)  ON DELETE CASCADE,
  contestant_id INTEGER NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
  PRIMARY KEY (category_id, contestant_id)
);

CREATE TABLE IF NOT EXISTS category_judges (
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  judge_id    INTEGER NOT NULL REFERENCES judges(id)     ON DELETE CASCADE,
  PRIMARY KEY (category_id, judge_id)
);

-- One cell of a judge's scoresheet.
CREATE TABLE IF NOT EXISTS scores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  judge_id      INTEGER NOT NULL REFERENCES judges(id)      ON DELETE CASCADE,
  contestant_id INTEGER NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
  criterion_id  INTEGER NOT NULL REFERENCES criteria(id)    ON DELETE CASCADE,
  score         REAL    NOT NULL CHECK (score >= 0),
  entered_by    TEXT,                             -- null = the judge; otherwise the encoder who typed it from the paper sheet
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (judge_id, contestant_id, criterion_id)
);

CREATE INDEX IF NOT EXISTS idx_scores_criterion  ON scores(criterion_id);
CREATE INDEX IF NOT EXISTS idx_scores_contestant ON scores(contestant_id);

-- The judges' vote on contingents the tie-break could not separate. It applies
-- only while exactly these contingents are still tied in this category.
CREATE TABLE IF NOT EXISTS tie_votes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id    INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  contestant_ids TEXT    NOT NULL,                -- JSON array of the tied contingents, ascending
  placing        TEXT    NOT NULL,                -- JSON array of the same contingents, as the judges placed them
  note           TEXT    NOT NULL DEFAULT '',     -- e.g. the vote count, printed with the result
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (category_id, contestant_ids)
);

-- A device of the tabulating team, used to encode scores from the judges' paper
-- sheets. It asks to pair with the team access code and can do nothing until
-- the tabulator approves it on the tabulation computer.
CREATE TABLE IF NOT EXISTS encoder_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  pairing_code TEXT    NOT NULL,                  -- shown on the device, checked by the tabulator before approving
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paired')),
  ip           TEXT,
  mac          TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  paired_at    TEXT
);

-- The judges whose paper sheets each encoder device may enter. A device with
-- none assigned can see the screen but cannot open or change any sheet.
CREATE TABLE IF NOT EXISTS encoder_judges (
  encoder_id INTEGER NOT NULL REFERENCES encoder_sessions(id) ON DELETE CASCADE,
  judge_id   INTEGER NOT NULL REFERENCES judges(id)           ON DELETE CASCADE,
  PRIMARY KEY (encoder_id, judge_id)
);

-- Submission lock: once a judge submits a category the sheet is read-only
-- until the tabulator reopens it.
CREATE TABLE IF NOT EXISTS scoresheets (
  judge_id     INTEGER NOT NULL REFERENCES judges(id)     ON DELETE CASCADE,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  submitted_at TEXT,
  PRIMARY KEY (judge_id, category_id)
);

-- The rule book: one row per line of the "Deductions" table.
-- Every deduction is taken from each judge's raw score for the contingent.
--   unit  = flat               : charged once per violation
--   unit  = per_minute         : charged per full minute over the limit
--   unit  = per_started_minute : charged per started minute over the limit
CREATE TABLE IF NOT EXISTS deduction_types (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,
  points        REAL    NOT NULL CHECK (points > 0),
  unit          TEXT    NOT NULL DEFAULT 'flat'
                CHECK (unit IN ('flat', 'per_minute', 'per_started_minute')),
  limit_seconds INTEGER CHECK (limit_seconds IS NULL OR limit_seconds > 0),
  notes         TEXT    NOT NULL DEFAULT '',
  sort_order    INTEGER NOT NULL DEFAULT 0
);

-- A penalty actually charged to a contingent. `points` is a snapshot of
-- type.points * quantity taken when the penalty was recorded.
CREATE TABLE IF NOT EXISTS deductions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contestant_id     INTEGER NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
  deduction_type_id INTEGER NOT NULL REFERENCES deduction_types(id),
  measured_seconds  INTEGER,
  quantity          REAL    NOT NULL DEFAULT 1 CHECK (quantity > 0),
  points            REAL    NOT NULL CHECK (points > 0),
  remarks           TEXT    NOT NULL DEFAULT '',
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deductions_contestant ON deductions(contestant_id);
