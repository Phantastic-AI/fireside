-- Δ conn — the exchange: two attendees who just met, swapping contacts by
-- name, RELIABLY, with the same law the reciprocal room layer already
-- proved: name is always visible, everything else (work, links, email) is a
-- separate opt-in the owner made themselves, read live off person.share_contact
-- at every request. Nothing here duplicates that opt-in machinery; it only
-- adds the missing piece — a place for the double opt-in itself to live.
--
-- Not built on the `connection` table on purpose. `connection` (0001_init)
-- is a one-sided note — "someone I mean to find" — written unilaterally by
-- workflows/social.ts's noteConnection with no consent from the other side,
-- always pinned to a shared starred session, and never gates anything (the
-- note is never visible to anyone but its writer). A mutual friend request is
-- the opposite shape on every axis: it needs the other person's own act
-- (accept) before it exists as a two-way fact, and it is not tied to any one
-- talk — two people can meet in a hallway between sessions neither of them
-- has starred. Bending `connection` to carry both meanings would touch the
-- critic-verified reciprocity code path for no real reuse; a new, small,
-- additive table is the smaller and safer change.
--
-- Status lives in timestamps, the house style (submission.decided_at,
-- star.watched_at/missed_at): request → requested_at; mutual → accepted_at;
-- either side lets go → revoked_at, which ends it whether it was still
-- pending (a cancel or a decline) or already accepted (an unfriend) — one
-- verb, one column, D-024's "one click, undoable" ethos.
CREATE TABLE friend_request (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES event(id),
  requester_id TEXT NOT NULL REFERENCES person(id),
  recipient_id TEXT NOT NULL REFERENCES person(id),
  requested_at INTEGER NOT NULL,
  accepted_at  INTEGER,
  revoked_at   INTEGER,
  UNIQUE (event_id, requester_id, recipient_id),
  CHECK (requester_id <> recipient_id),
  CHECK (accepted_at IS NULL OR accepted_at >= requested_at)
);

-- "X would like to connect" — one lookup, one direction, live only.
CREATE INDEX idx_friend_request_incoming
  ON friend_request(recipient_id, event_id) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Both halves of "am I already asked / already friends with this person" —
-- the search results and the request button both read this before rendering.
CREATE INDEX idx_friend_request_requester_live
  ON friend_request(requester_id, event_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_friend_request_recipient_live
  ON friend_request(recipient_id, event_id) WHERE revoked_at IS NULL;

-- "Your people" — the friends list itself, one direction of the query;
-- the other direction is idx_friend_request_recipient_live above with the
-- same accepted/not-revoked predicate.
CREATE INDEX idx_friend_request_requester_accepted
  ON friend_request(requester_id, event_id) WHERE accepted_at IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX idx_friend_request_recipient_accepted
  ON friend_request(recipient_id, event_id) WHERE accepted_at IS NOT NULL AND revoked_at IS NULL;
