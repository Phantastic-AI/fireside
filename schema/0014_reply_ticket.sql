-- 0014: reply tickets — the short, unguessable id that rides in a reminder's
-- Reply-To (reply+<id>@onfireside.com) so a speaker or their helper can send a
-- deck back by simply replying to the email, without ever opening the app.
--
-- The id is the whole key: it names the file-request task and the speaker it
-- belongs to. One ticket per task, reused across every reminder about it. It
-- carries no authority on its own — the inbound handler still checks the
-- reply's envelope-from is the speaker or one of their active helpers, so a
-- forwarded ticket in the wrong hands submits nothing. A short random id
-- (not a signed token) because an email local-part is capped at 64 octets.
CREATE TABLE reply_ticket (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES task(id),
  speaker_person_id TEXT NOT NULL REFERENCES person(id),
  created_at        INTEGER NOT NULL,
  UNIQUE (task_id)
);
CREATE INDEX idx_reply_ticket_task ON reply_ticket(task_id);
