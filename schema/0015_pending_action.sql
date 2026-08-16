-- 0015: the two-phase agentic-write ledger (D-037).
--
-- The concierge's planner (an LLM) is untrusted: it may only PROPOSE. A write
-- that needs confirming is canonicalised and stored here first, with its
-- arguments frozen and digested. A human then confirms the exact stored
-- manifest through a deterministic surface the model never authored, and only
-- then does the server re-authorise and execute that one row's action. So a
-- prompt-injected or hallucinating planner can at most write a row a human
-- rejects — it can never reach the real workflow with arguments nobody saw.
--
-- Direct-tier actions (reversible, self-scoped: star, follow) do NOT land here;
-- they execute inline. Only 'confirm' and 'confirm-number' actions are staged.
CREATE TABLE pending_action (
  id             TEXT PRIMARY KEY,
  person_id      TEXT NOT NULL REFERENCES person(id),
  event_id       TEXT REFERENCES event(id),          -- null for cross-event / onboarding acts
  surface        TEXT NOT NULL,                       -- where it was proposed; capability is re-checked against it
  action_type    TEXT NOT NULL,
  args_json      TEXT NOT NULL,                       -- canonical, immutable — the source of truth at commit
  args_digest    TEXT NOT NULL,                       -- sha-256 of args_json, shown in the manifest and the audit
  manifest       TEXT NOT NULL,                       -- the exact human-readable sentence the confirm UI shows
  tier           TEXT NOT NULL,                       -- 'confirm' | 'confirm-number'
  count_expected INTEGER,                             -- set for 'confirm-number'; the number the human must re-state
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,                    -- a stale proposal cannot be committed
  committed_at   INTEGER,                             -- one-time execution: set once, guarded
  status         TEXT NOT NULL DEFAULT 'open',        -- open | committed | cancelled
  CHECK (tier IN ('confirm', 'confirm-number')),
  CHECK (status IN ('open', 'committed', 'cancelled'))
);
CREATE INDEX idx_pending_action_person ON pending_action(person_id) WHERE status = 'open';

-- The audit trail: what actually committed, by whom, over what exact args —
-- without dumping model context or bulk PII. One row per executed action.
CREATE TABLE agent_audit (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL,
  event_id    TEXT,
  action_type TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  outcome     TEXT NOT NULL,                          -- 'done' | a refusal word
  at          INTEGER NOT NULL
);
