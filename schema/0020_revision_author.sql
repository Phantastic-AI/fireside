-- T608: a version says whose hand wrote it. Nullable — every revision written
-- before this column existed reads as an unknown hand, never a guessed one.
ALTER TABLE revision ADD COLUMN author_id TEXT REFERENCES person(id);
