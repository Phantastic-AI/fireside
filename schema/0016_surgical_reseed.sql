-- Surgical reseed (R-2 revised): the nightly rebuild flushes only what the
-- seed owns — the demo conferences and the fixture cast — and leaves every
-- real account, real event, and real row a customer created standing. Two
-- pieces of schema make that boundary expressible:

-- 1. The sourcing board is install-wide, so a card made by a judge signed in
--    AS the demo organizer must rebuild nightly while a real organizer's card
--    survives. Authorship is the only honest boundary between those two, so a
--    card now remembers who made it. NULL (legacy, unknown) counts as demo
--    and is flushed.
ALTER TABLE crm_card ADD COLUMN created_by TEXT REFERENCES person(id);

-- 2. The fixture manifest: every person id the seed owns, refreshed by each
--    reseed before it deletes anything, so scoped deletes can say
--    "IN (SELECT id FROM _seed_person)" instead of shipping a thousand ids
--    into every statement.
CREATE TABLE _seed_person (
  id TEXT PRIMARY KEY
);
