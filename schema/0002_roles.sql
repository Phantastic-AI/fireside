-- Per-conference roles with tiers (D-026). A person's standing on one event.
-- Super organizers live on person.internal_role = 'organizer' (install-wide);
-- everyone else's power is a row here. Enforcement is one chokepoint:
-- can(principal, capability, event) in the tool registry.
CREATE TABLE event_role (
  person_id  TEXT NOT NULL REFERENCES person(id),
  event_id   TEXT NOT NULL REFERENCES event(id),
  role       TEXT NOT NULL CHECK (role IN ('owner','approver','editor','viewer')),
  granted_at INTEGER NOT NULL,
  granted_by TEXT REFERENCES person(id),
  PRIMARY KEY (person_id, event_id)
);
CREATE INDEX idx_event_role_event ON event_role(event_id);
