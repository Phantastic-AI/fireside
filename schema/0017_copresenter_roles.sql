-- T604: a submission's people carry real roles. The CHECK grows co_author
-- (contributed, not on stage) and panelist alongside the original three.
-- SQLite cannot widen a CHECK in place, so the table is rebuilt the same way
-- 0004 rebuilt event_role: copy, drop, rename, re-index.
CREATE TABLE participation_new (
  submission_id TEXT NOT NULL REFERENCES submission(id),
  person_id     TEXT NOT NULL REFERENCES person(id),
  role          TEXT NOT NULL DEFAULT 'speaker'
                CHECK (role IN ('speaker','co_speaker','co_author','panelist','moderator')),
  position      INTEGER NOT NULL DEFAULT 0,
  is_submitter  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (submission_id, person_id)
);
INSERT INTO participation_new (submission_id, person_id, role, position, is_submitter)
  SELECT submission_id, person_id, role, position, is_submitter FROM participation;
DROP TABLE participation;
ALTER TABLE participation_new RENAME TO participation;
CREATE UNIQUE INDEX idx_participation_one_submitter
  ON participation(submission_id) WHERE is_submitter = 1;
CREATE INDEX idx_participation_person ON participation(person_id);
