-- CNT-05: a short comment thread on a deliverable request (operator, 2026-08-12).
--
-- Threaded on the task, not on one file version: the conversation is about
-- the deliverable ("send your slides"), and a reply from before the second
-- upload still has to read true after it. Keeping it off `file` means a new
-- version never orphans the thread that led to it.
--
-- Additive only — a new table, nothing touched on any existing one.
CREATE TABLE file_comment (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES task(id),
  author_person_id  TEXT NOT NULL REFERENCES person(id),
  body              TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_file_comment_task ON file_comment(task_id, created_at);
