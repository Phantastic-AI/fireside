-- T611 (A-prime): named lanyard links. Day-of check-in without accounts —
-- the organizer mints a link with a name on it ("Sam, front door"), hands it
-- to the human it names, and every mark that link makes is stamped with its
-- name and the time. One link per human, revocable alone, so the name is the
-- person in practice and attribution survives the morning rush.
CREATE TABLE checkin_link (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES event(id),
  name       TEXT NOT NULL,
  nonce      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_checkin_link_event ON checkin_link(event_id);

-- One arrival per session. Unmarking deletes the row — the same hands that
-- can mark can honestly unmark a mistake, and the stamp always names the
-- link that made the mark now standing.
CREATE TABLE checkin (
  submission_id TEXT PRIMARY KEY REFERENCES submission(id),
  link_id       TEXT NOT NULL REFERENCES checkin_link(id),
  marked_at     INTEGER NOT NULL
);
