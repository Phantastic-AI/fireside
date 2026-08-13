-- Submission waves (operator, 2026-08-12, D-033).
--
-- A call can open in more than one window — an early call, a main call, a late
-- extension. The windows are an ordered JSON list on the event, each with a
-- name and its own opens/closes. Empty (the default) means the single call the
-- product always had: cfp_opens_at / cfp_closes_at are untouched and stay the
-- one window. So this is additive — an event with no windows behaves exactly
-- as before.
--
-- Shape of submission_windows, when set:
--   [{"name":"Early call","opensAt":<ms>,"closesAt":<ms>}, {"name":"Main call",...}]
--
-- Each proposal remembers which wave it arrived in, by name. Null for proposals
-- written before waves, or into an event that has none.

ALTER TABLE event ADD COLUMN submission_windows TEXT NOT NULL DEFAULT '[]';
ALTER TABLE submission ADD COLUMN wave TEXT;
