-- CNT: a per-deliverable share link, the same revocable-nonce shape the
-- product already uses for the green room (event.green_room_nonce) and a
-- speaker's own schedule (my_schedule.share_nonce) — so an AV or web crew can
-- be handed a link to one deliverable's current file and its version history
-- without a Fireside sign-in.
--
-- Keyed on the task rather than on a file id: a version's own id changes on
-- every re-upload (CNT-04's whole point), and a link that broke on the next
-- upload would be a worse fix than the raw-download-on-click bug it replaces.
-- One link per deliverable request, however many versions pass under it.
--
-- Additive only.
ALTER TABLE task ADD COLUMN share_nonce TEXT;
CREATE UNIQUE INDEX idx_task_share_nonce ON task(share_nonce) WHERE share_nonce IS NOT NULL;
