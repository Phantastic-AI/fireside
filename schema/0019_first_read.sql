-- T606: the AI first read. One row per submission per round — a first-pass
-- score per numeric criterion with a written reason, produced only when a
-- decider presses the button, shown everywhere DISTINCT from human reviews
-- and never mixed into the committee's average. A human override sits beside
-- the machine's number, attributed and timestamped, and hides nothing.
CREATE TABLE first_read (
  id             TEXT PRIMARY KEY,
  submission_id  TEXT NOT NULL REFERENCES submission(id),
  round          INTEGER NOT NULL,
  scores         TEXT NOT NULL,        -- {criterionKey: number}
  rationale      TEXT NOT NULL,        -- the written reasons, citing the abstract
  model          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  override_score REAL,
  override_by    TEXT REFERENCES person(id),
  override_at    INTEGER,
  UNIQUE (submission_id, round)
);
CREATE INDEX idx_first_read_submission ON first_read(submission_id, round);
