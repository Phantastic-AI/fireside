-- A fifth standing: 'reviewer'. Somebody who reads and scores the pile they
-- were handed and sees no organizer screen at all. The CHECK in 0002 is a
-- closed list, and SQLite only widens one by rebuilding the table, so this is
-- the same table with one more word allowed in the same column.
CREATE TABLE event_role_new (
  person_id  TEXT NOT NULL REFERENCES person(id),
  event_id   TEXT NOT NULL REFERENCES event(id),
  role       TEXT NOT NULL CHECK (role IN ('owner','approver','editor','viewer','reviewer')),
  granted_at INTEGER NOT NULL,
  granted_by TEXT REFERENCES person(id),
  PRIMARY KEY (person_id, event_id)
);
INSERT INTO event_role_new (person_id, event_id, role, granted_at, granted_by)
  SELECT person_id, event_id, role, granted_at, granted_by FROM event_role;
DROP TABLE event_role;
ALTER TABLE event_role_new RENAME TO event_role;
CREATE INDEX idx_event_role_event ON event_role(event_id);
