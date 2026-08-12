-- D-027: the eval harness (and half of humanity) signs in with a password.
-- Passwords are optional per person; magic links remain a first-class door.
ALTER TABLE person ADD COLUMN password_hash TEXT;
