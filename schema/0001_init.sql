-- Fireside schema — the rules live in the database, not in good intentions.
-- Tier-1 verification: these constraints and triggers ARE the first proof.
-- Times: *_at columns are unix epoch milliseconds; *_on and *_day columns are
-- ISO dates ('YYYY-MM-DD'). All ids are deterministic TEXT (seed-stable, R-2).

-- The guard table: a batch opens with an INSERT that selects zero rows when
-- its precondition holds and one CHECK-violating row when it went stale,
-- aborting the whole batch atomically. Proven on live D1 at CP0.
CREATE TABLE _guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

CREATE TABLE event (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  tagline           TEXT,
  logo_file_id      TEXT,
  accent            TEXT,
  starts_on         TEXT NOT NULL,
  ends_on           TEXT NOT NULL,
  timezone          TEXT NOT NULL,
  tz_label          TEXT,                          -- "All times PT"
  venue_name        TEXT,
  venue_address     TEXT,
  cfp_opens_at      INTEGER,
  cfp_closes_at     INTEGER,
  cfp_intro         TEXT,
  cfp_success_message TEXT,
  questions         TEXT NOT NULL DEFAULT '[]',    -- R-10: typed question defs, JSON
  max_submissions   INTEGER NOT NULL DEFAULT 3,
  decide_by         TEXT,
  current_round     INTEGER NOT NULL DEFAULT 1,    -- R-11
  round_scorecards  TEXT NOT NULL DEFAULT '{}',    -- R-11: per-round scorecard defs, JSON
  day_start         TEXT NOT NULL DEFAULT '09:00',
  day_end           TEXT NOT NULL DEFAULT '18:00',
  block_minutes     INTEGER NOT NULL DEFAULT 30,
  agenda_published  INTEGER NOT NULL DEFAULT 0,
  green_room_nonce  TEXT,                          -- R-4: rotate to revoke
  created_at        INTEGER NOT NULL
);

CREATE TABLE person (
  id                TEXT PRIMARY KEY,
  email             TEXT UNIQUE COLLATE NOCASE,
  name              TEXT NOT NULL,
  sort_name         TEXT,
  headshot_file_id  TEXT,
  bio               TEXT,
  job_title         TEXT,
  organisation      TEXT,
  links             TEXT,
  pronouns          TEXT,
  phone             TEXT,
  internal_role     TEXT CHECK (internal_role IN ('organizer', 'reviewer')),
  google_sub        TEXT UNIQUE,
  share_contact     TEXT NOT NULL DEFAULT '{}',    -- Δ12: {work, links, email} opt-ins
  last_signed_in_at INTEGER,
  created_at        INTEGER NOT NULL
);

CREATE TABLE track (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES event(id),
  name      TEXT NOT NULL,
  slug      TEXT NOT NULL,
  colour    TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, slug)
);

CREATE TABLE room (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES event(id),
  name      TEXT NOT NULL,
  capacity  INTEGER,
  position  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, name)
);

CREATE TABLE submission (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL REFERENCES event(id),
  title            TEXT NOT NULL,
  abstract         TEXT,
  format           TEXT NOT NULL,
  track_id         TEXT REFERENCES track(id),
  level            TEXT,
  requested_min    INTEGER NOT NULL DEFAULT 30,
  extra            TEXT NOT NULL DEFAULT '{}',     -- R-10 answers, keyed by question id
  source           TEXT NOT NULL DEFAULT 'cfp'
                   CHECK (source IN ('cfp', 'seeded', 'organizer')),
  created_at       INTEGER NOT NULL,
  submitted_at     INTEGER,
  resume_nonce     TEXT,
  score            INTEGER,                        -- the chair's own call; averages derive
  score_notes      TEXT,
  state            TEXT NOT NULL DEFAULT 'draft'
                   CHECK (state IN ('draft','submitted','accepted','waitlisted',
                                    'rejected','withdrawn','cancelled')),
  decision_version INTEGER NOT NULL DEFAULT 0,     -- bumps on every decide/reverse
  decided_at       INTEGER,
  decision_note    TEXT,                           -- the committee's own sentence
  cancelled_at     INTEGER,
  cancel_note      TEXT,
  notified_at      INTEGER,                        -- telling is a second act
  starts_at        INTEGER,
  room_id          TEXT REFERENCES room(id),
  public_slug      TEXT,
  recording_url    TEXT,                           -- orthogonal to everything (01 inv. 6)
  -- a draft has not been sent; everything else has
  CHECK (state <> 'draft' OR submitted_at IS NULL),
  -- placement belongs to the agenda: accepted, or cancelled-in-place (01 inv. 2/Δ4)
  CHECK ((room_id IS NULL AND starts_at IS NULL) OR state IN ('accepted','cancelled')),
  -- cancelled and cancelled_at are one fact, not two
  CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX idx_submission_public_slug
  ON submission(event_id, public_slug) WHERE public_slug IS NOT NULL;
CREATE INDEX idx_submission_event_state ON submission(event_id, state);
CREATE INDEX idx_submission_decided_not_told
  ON submission(event_id) WHERE state IN ('accepted','waitlisted','rejected')
                            AND notified_at IS NULL;
CREATE INDEX idx_submission_agenda ON submission(event_id, starts_at)
  WHERE starts_at IS NOT NULL;

-- The state machine, enforced where good intentions can't reach (01 §1.3).
CREATE TRIGGER trg_submission_transition
BEFORE UPDATE OF state ON submission
WHEN old.state <> new.state AND NOT (
     (old.state = 'draft'      AND new.state = 'submitted')
  OR (old.state = 'submitted'  AND new.state IN ('accepted','waitlisted','rejected','withdrawn'))
  OR (old.state = 'waitlisted' AND new.state IN ('accepted','rejected','withdrawn'))
  OR (old.state = 'accepted'   AND new.state IN ('waitlisted','rejected','withdrawn','cancelled'))
  OR (old.state = 'cancelled'  AND new.state = 'accepted')
)
BEGIN
  SELECT RAISE(ABORT, 'illegal transition');
END;

-- A room holds one live session at a time; cancelled holds no room (01 inv. 5).
CREATE TRIGGER trg_submission_room_overlap_update
BEFORE UPDATE OF starts_at, room_id, state ON submission
WHEN new.starts_at IS NOT NULL AND new.room_id IS NOT NULL AND new.state = 'accepted'
 AND EXISTS (
   SELECT 1 FROM submission s
   WHERE s.id <> new.id
     AND s.event_id = new.event_id
     AND s.room_id = new.room_id
     AND s.state = 'accepted'
     AND s.starts_at IS NOT NULL
     AND s.starts_at < new.starts_at + new.requested_min * 60000
     AND new.starts_at < s.starts_at + s.requested_min * 60000
 )
BEGIN
  SELECT RAISE(ABORT, 'room overlap');
END;

CREATE TRIGGER trg_submission_room_overlap_insert
BEFORE INSERT ON submission
WHEN new.starts_at IS NOT NULL AND new.room_id IS NOT NULL AND new.state = 'accepted'
 AND EXISTS (
   SELECT 1 FROM submission s
   WHERE s.event_id = new.event_id
     AND s.room_id = new.room_id
     AND s.state = 'accepted'
     AND s.starts_at IS NOT NULL
     AND s.starts_at < new.starts_at + new.requested_min * 60000
     AND new.starts_at < s.starts_at + s.requested_min * 60000
 )
BEGIN
  SELECT RAISE(ABORT, 'room overlap');
END;

-- Event-scope isolation: SQLite FKs can't carry the composite check (08 §3).
CREATE TRIGGER trg_submission_track_scope
BEFORE INSERT ON submission
WHEN new.track_id IS NOT NULL
 AND (SELECT event_id FROM track WHERE id = new.track_id) <> new.event_id
BEGIN SELECT RAISE(ABORT, 'track belongs to another event'); END;

CREATE TRIGGER trg_submission_track_scope_update
BEFORE UPDATE OF track_id ON submission
WHEN new.track_id IS NOT NULL
 AND (SELECT event_id FROM track WHERE id = new.track_id) <> new.event_id
BEGIN SELECT RAISE(ABORT, 'track belongs to another event'); END;

CREATE TRIGGER trg_submission_room_scope
BEFORE UPDATE OF room_id ON submission
WHEN new.room_id IS NOT NULL
 AND (SELECT event_id FROM room WHERE id = new.room_id) <> new.event_id
BEGIN SELECT RAISE(ABORT, 'room belongs to another event'); END;

CREATE TABLE review (
  id                 TEXT PRIMARY KEY,
  submission_id      TEXT NOT NULL REFERENCES submission(id),
  reviewer_person_id TEXT NOT NULL REFERENCES person(id),
  round              INTEGER NOT NULL,
  scores             TEXT NOT NULL DEFAULT '{}',   -- per-scorecard JSON
  note               TEXT,
  submitted_at       INTEGER,                      -- D-024: staged until submitted
  UNIQUE (submission_id, reviewer_person_id, round)
);
CREATE INDEX idx_review_reviewer ON review(reviewer_person_id, round);

CREATE TABLE participation (
  submission_id TEXT NOT NULL REFERENCES submission(id),
  person_id     TEXT NOT NULL REFERENCES person(id),
  role          TEXT NOT NULL DEFAULT 'speaker'
                CHECK (role IN ('speaker','co_speaker','moderator')),
  position      INTEGER NOT NULL DEFAULT 0,
  is_submitter  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (submission_id, person_id)
);
CREATE UNIQUE INDEX idx_participation_one_submitter
  ON participation(submission_id) WHERE is_submitter = 1;
CREATE INDEX idx_participation_person ON participation(person_id);

CREATE TABLE task (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES event(id),
  person_id     TEXT NOT NULL REFERENCES person(id),
  submission_id TEXT REFERENCES submission(id),
  kind          TEXT NOT NULL,
  template_key  TEXT,
  title         TEXT NOT NULL,
  instructions  TEXT,
  due_on        TEXT,
  completed_at  INTEGER,
  cancelled_at  INTEGER,
  cancel_reason TEXT CHECK (cancel_reason IN ('manual','decision_reversal','session_cancelled')),
  response      TEXT,
  -- a cancellation always says why; an open task carries no reason
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL))
);
CREATE INDEX idx_task_person ON task(person_id, event_id);
CREATE INDEX idx_task_submission ON task(submission_id);

CREATE TRIGGER trg_task_submission_scope
BEFORE INSERT ON task
WHEN new.submission_id IS NOT NULL
 AND (SELECT event_id FROM submission WHERE id = new.submission_id) <> new.event_id
BEGIN SELECT RAISE(ABORT, 'task crosses events'); END;

CREATE TABLE file (
  id                    TEXT PRIMARY KEY,
  owner_kind            TEXT NOT NULL CHECK (owner_kind IN ('submission','person','event')),
  owner_id              TEXT NOT NULL,
  filename              TEXT NOT NULL,
  r2_key                TEXT NOT NULL UNIQUE,
  content_type          TEXT NOT NULL,
  size_bytes            INTEGER NOT NULL,
  uploaded_at           INTEGER NOT NULL,
  uploaded_by_person_id TEXT REFERENCES person(id),
  replaced_at           INTEGER                     -- old rows stay ("Earlier uploads")
);
CREATE INDEX idx_file_owner ON file(owner_kind, owner_id);

CREATE TABLE message (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL REFERENCES event(id),
  person_id        TEXT NOT NULL REFERENCES person(id),
  submission_id    TEXT REFERENCES submission(id),
  kind             TEXT NOT NULL,
  decision_version INTEGER,                        -- a stale letter can't release
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  delivered_at     INTEGER,
  emailed_at       INTEGER,                        -- R-12: real addresses get real email
  blocked_reason   TEXT
);
CREATE UNIQUE INDEX idx_message_one_undelivered_decision
  ON message(submission_id, decision_version)
  WHERE kind = 'decision' AND delivered_at IS NULL;
CREATE INDEX idx_message_person ON message(person_id, event_id);
CREATE INDEX idx_message_outbox ON message(event_id) WHERE delivered_at IS NULL;

CREATE TRIGGER trg_message_submission_scope
BEFORE INSERT ON message
WHEN new.submission_id IS NOT NULL
 AND (SELECT event_id FROM submission WHERE id = new.submission_id) <> new.event_id
BEGIN SELECT RAISE(ABORT, 'message crosses events'); END;

CREATE TABLE my_schedule (
  id            TEXT PRIMARY KEY,
  person_id     TEXT NOT NULL REFERENCES person(id),
  event_id      TEXT NOT NULL REFERENCES event(id),
  share_nonce   TEXT,
  share_enabled INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (person_id, event_id)
);

CREATE TABLE star (
  id             TEXT PRIMARY KEY,
  my_schedule_id TEXT NOT NULL REFERENCES my_schedule(id),
  submission_id  TEXT NOT NULL REFERENCES submission(id),
  starred_at     INTEGER NOT NULL,
  watched_at     INTEGER,
  missed_at      INTEGER,
  shared_at      INTEGER,                          -- Δ12: the social act, separate from Saw it
  connect_note   TEXT,
  UNIQUE (my_schedule_id, submission_id),
  CHECK (NOT (watched_at IS NOT NULL AND missed_at IS NOT NULL))
);
CREATE INDEX idx_star_submission_shared
  ON star(submission_id) WHERE shared_at IS NOT NULL;

CREATE TRIGGER trg_star_event_scope
BEFORE INSERT ON star
WHEN (SELECT event_id FROM my_schedule WHERE id = new.my_schedule_id)
  <> (SELECT event_id FROM submission WHERE id = new.submission_id)
BEGIN SELECT RAISE(ABORT, 'star crosses events'); END;

CREATE TABLE connection (
  id              TEXT PRIMARY KEY,
  owner_person_id TEXT NOT NULL REFERENCES person(id),
  other_person_id TEXT NOT NULL REFERENCES person(id),
  submission_id   TEXT NOT NULL REFERENCES submission(id),
  note            TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (owner_person_id, other_person_id, submission_id),
  CHECK (owner_person_id <> other_person_id)
);
CREATE INDEX idx_connection_owner ON connection(owner_person_id);

CREATE TABLE embedding (
  id         TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('submission','answer')),
  owner_id   TEXT NOT NULL,
  event_id   TEXT NOT NULL REFERENCES event(id),
  vector     BLOB NOT NULL,                        -- normalized Float32
  model      TEXT NOT NULL,
  text_hash  TEXT NOT NULL,
  built_at   INTEGER NOT NULL,
  UNIQUE (owner_kind, owner_id)
);
CREATE INDEX idx_embedding_event ON embedding(event_id);

CREATE TABLE matrix_cache (
  event_id    TEXT PRIMARY KEY REFERENCES event(id),
  corpus_hash TEXT NOT NULL,
  packed      BLOB NOT NULL,                       -- one Float32 matrix per event
  built_at    INTEGER NOT NULL
);

CREATE TABLE neighbor (
  submission_id TEXT PRIMARY KEY REFERENCES submission(id),
  top3          TEXT NOT NULL,                     -- JSON ids; More-like-this is a plain read
  corpus_hash   TEXT NOT NULL
);

CREATE TABLE theme_cache (
  event_id    TEXT PRIMARY KEY REFERENCES event(id),
  corpus_hash TEXT NOT NULL,
  themes_json TEXT NOT NULL,
  built_at    INTEGER NOT NULL
);

CREATE TABLE revision (
  id         TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('submission','message','answer')),
  owner_id   TEXT NOT NULL,
  body       TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_revision_owner ON revision(owner_kind, owner_id);

CREATE TABLE question (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES event(id),
  scope           TEXT NOT NULL CHECK (scope IN ('public','speaker','organizer')),
  conversation_id TEXT,
  text            TEXT NOT NULL,
  answered        INTEGER NOT NULL DEFAULT 0,
  answer_snapshot TEXT,
  asked_at        INTEGER NOT NULL,
  organizer_note  TEXT,
  annotated_at    INTEGER
  -- no person_id, by design: program feedback, not a record of who asked
);
CREATE INDEX idx_question_event ON question(event_id, answered);

CREATE TABLE answer (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES event(id),
  question_text      TEXT NOT NULL,
  body               TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('suggested','in_use','replaced')),
  supersedes_id      TEXT REFERENCES answer(id),
  source_question_id TEXT REFERENCES question(id),
  created_at         INTEGER NOT NULL,
  accepted_at        INTEGER
);
CREATE UNIQUE INDEX idx_answer_one_in_use
  ON answer(event_id, question_text) WHERE state = 'in_use';

-- Ask spend guard (O-9 shapes when exhausted)
CREATE TABLE ai_budget (
  day   TEXT NOT NULL,                             -- 'YYYY-MM-DD'
  ip    TEXT NOT NULL,                             -- '_global' for the daily total
  spent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ip)
);
