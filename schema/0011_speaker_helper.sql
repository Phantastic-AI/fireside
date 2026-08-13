-- Δ helper — a speaker's own logistics helper: someone who takes care of the
-- deck, confirms travel, and sends in what the committee asks for, without
-- being on the program themselves. "Someone who helps me with this," not a
-- second speaker.
--
-- The access story is deliberately small: a helper reaches the SAME portal
-- through the SAME magic-link door every speaker already uses
-- (workflows/account.ts's makeMagicLink cares only that person.email exists —
-- this table adds no second sign-in path, no password, nothing new to guess).
-- What is new is the SCOPE: routes/public/portal.ts reads this table to
-- decide whether a signed-in person who is nobody's own participant here is
-- instead helping one who is, and if so renders that speaker's tasks and
-- deliverables — never the talk's own words or standing, which stay the
-- speaker's alone.
--
-- Shaped after friend_request (schema/0010): a directed relationship between
-- two person rows, one row per pair per event, reactivated in place on a
-- second add rather than re-inserted (the UNIQUE triple below), status held
-- in timestamps rather than a state column — added_at / removed_at — the
-- same D-024 "one click, undoable" ethos as everything else in this build.
-- Not layered onto participation (0001_init): that table is program standing
-- (speaker, co_speaker, moderator, one submitter) with a CHECK the trigger
-- layer already leans on hard, and a helper has no standing on the talk at
-- all — bending participation to carry a fourth, non-program role would touch
-- that surface for no real reuse.
CREATE TABLE speaker_helper (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES event(id),
  speaker_person_id TEXT NOT NULL REFERENCES person(id),
  helper_person_id  TEXT NOT NULL REFERENCES person(id),
  added_at          INTEGER NOT NULL,
  removed_at        INTEGER,
  UNIQUE (event_id, speaker_person_id, helper_person_id),
  CHECK (speaker_person_id <> helper_person_id)
);

-- "People who help you" — the speaker's own list, live relationships only.
CREATE INDEX idx_speaker_helper_speaker_live
  ON speaker_helper(event_id, speaker_person_id) WHERE removed_at IS NULL;

-- The other direction: which speaker(s) a signed-in person helps at this
-- event — how the portal finds the helper-scoped view for someone who is not
-- themselves a participant here (queries/helpers.ts's helpingAt), and how a
-- task write is allowed to act as the speaker who owns the task
-- (queries/helpers.ts's taskActorId).
CREATE INDEX idx_speaker_helper_helper_live
  ON speaker_helper(helper_person_id, event_id) WHERE removed_at IS NULL;
