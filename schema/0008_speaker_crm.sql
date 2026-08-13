-- Speaker CRM (07) plus the roster/import gap in speaker management (03).
--
-- Two problems, one migration, because the second is what makes the first
-- possible without inventing a duplicate "contact" concept:
--
--   1. `person` is already the org-wide directory (it always was — nothing
--      about it is scoped to one event). CRM adds nothing new for identity;
--      it only adds what a contact can carry BESIDE the identity a proposal
--      already gives them: notes, a tag or two, one custom field, a sourcing
--      card, and a saved search. Additive columns and additive tables only.
--
--   2. The event roster (queries/people.ts) currently reads speakers off
--      participation on a non-draft submission — so a person imported from a
--      CSV, or pushed in from the CRM directory, has nowhere to land at an
--      event until they have a proposal, which a freshly-imported speaker
--      does not yet have. `roster_entry` is that landing spot: "this person
--      belongs to this event's list" is now a fact of its own, independent
--      of whether they have submitted anything yet. A person with both a
--      roster_entry and a real proposal is not double-counted — the reading
--      code treats participation as the stronger fact and roster_entry as
--      the fallback for everyone participation does not yet reach.
--
-- Nothing here touches submission, participation, or task — the tables the
-- proposal and content-management areas own — and nothing here is required
-- for the product to keep working exactly as it did before this file ran.

-- Travel/logistics free text (SPK-15) and one custom field (CRM-04). Both
-- default to absent, so an untouched person is unchanged.
ALTER TABLE person ADD COLUMN logistics TEXT;
ALTER TABLE person ADD COLUMN speaker_type TEXT CHECK (speaker_type IN ('internal', 'external'));

-- A soft merge (CRM-06): the losing record is never deleted — deleting it
-- could orphan a task, a message, or a review written against its id before
-- anyone reads this file — it is only marked as folded into the winner, and
-- every reader of the directory excludes anyone with this set.
ALTER TABLE person ADD COLUMN merged_into_id TEXT REFERENCES person(id);

-- "This person is on this event's list" — the fact roster_entry exists to
-- hold, wherever a real proposal does not hold it yet. One row per person per
-- event; a second import or a second "add to event" push just confirms the
-- one that is already there.
CREATE TABLE roster_entry (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES event(id),
  person_id  TEXT NOT NULL REFERENCES person(id),
  source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'crm')),
  created_at INTEGER NOT NULL,
  UNIQUE (event_id, person_id)
);
CREATE INDEX idx_roster_entry_event ON roster_entry(event_id);
CREATE INDEX idx_roster_entry_person ON roster_entry(person_id);

-- An internal note, on a contact or on a sourcing card. Same owner_kind /
-- owner_id shape file and revision already use, so a third kind of note does
-- not need a fourth pattern.
CREATE TABLE crm_note (
  id         TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('person', 'card')),
  owner_id   TEXT NOT NULL,
  author_id  TEXT NOT NULL REFERENCES person(id),
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_crm_note_owner ON crm_note(owner_kind, owner_id, created_at);

-- Free-form tags (CRM-04's plainer half).
CREATE TABLE crm_tag (
  person_id TEXT NOT NULL REFERENCES person(id),
  tag       TEXT NOT NULL,
  PRIMARY KEY (person_id, tag)
);

-- A saved search (CRM-09). The filter itself IS the query string a directory
-- screen already builds from its own form — saving one is copying that
-- string under a name, nothing more. `member_ids` is set only for a curated
-- (fixed-membership) save; a dynamic save leaves it null and the query runs
-- fresh every time the segment is opened.
CREATE TABLE crm_segment (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'dynamic' CHECK (kind IN ('dynamic', 'curated')),
  query      TEXT NOT NULL,
  member_ids TEXT,
  created_by TEXT NOT NULL REFERENCES person(id),
  created_at INTEGER NOT NULL
);

-- The sourcing pipeline (CRM-07). One open card per contact — enrolling
-- somebody a second time moves their existing card rather than laying a
-- second one beside it, the same "one truth, not a growing pile of them"
-- rule the rest of the schema keeps.
CREATE TABLE crm_card (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES person(id),
  stage      TEXT NOT NULL DEFAULT 'researching'
             CHECK (stage IN ('researching', 'identified', 'contacted', 'interested',
                               'confirmed', 'declined')),
  score      INTEGER,
  rationale  TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (person_id)
);

-- Every stage move, timestamped (CRM-08). The enroll itself is a row here
-- too, with from_stage null, so "when were they enrolled" needs no second
-- column on crm_card.
CREATE TABLE crm_card_event (
  id         TEXT PRIMARY KEY,
  card_id    TEXT NOT NULL REFERENCES crm_card(id),
  from_stage TEXT,
  to_stage   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_crm_card_event_card ON crm_card_event(card_id, created_at);
