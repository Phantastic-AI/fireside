-- T605: automated due-date reminders. Two facts make the daily pass honest:
-- which calendar day a task last nagged on (so it never nags twice in a day),
-- and whether this event wants the machine reminding at all (on by default;
-- an organizer who prefers to do all the asking turns it off in settings).
ALTER TABLE task ADD COLUMN last_reminded_on TEXT;
ALTER TABLE event ADD COLUMN auto_reminders INTEGER NOT NULL DEFAULT 1;
