# Architecture

One Cloudflare Worker serves everything: server-rendered HTML through
Hono, no client framework, no build pipeline beyond `wrangler deploy`.
D1 (SQLite) holds the world; R2 holds files; Workers AI answers Ask;
Email Sending carries the letters that are allowed to leave.

## The shape

```
src/
  index.ts            the one entry: routes registered in matcher-safe order
  lib/                html shells · label map · db guards · signing
  queries/            the READ boundary — screens never write SQL
  workflows/          the WRITE boundary — every mutation is a guarded batch
  routes/public/      onstage screens (warm register)
  routes/admin/       backstage screens (plain register)
  islands/            tiny client scripts, inlined; the page works without them
  mcp.ts              the same doors, JSON-RPC 2.0, stateless
seed/                 the deterministic demonstration world
schema/               DDL: tables, triggers, partial unique indexes
```

Two boundaries carry the whole design:

- **Reads go through `queries/`.** Each function takes a `Principal` and
  refuses out-of-scope reads itself (`requireScope`), so a screen cannot
  accidentally widen what a viewer sees. The portal's DTO simply does not
  contain decision facts that have not been sent — the not-told invariant
  is enforced by absence, not by an `if` in a template.
- **Writes go through `workflows/`** as *guarded batches*. D1's `batch()`
  is atomic, so every multi-statement write opens with a guard: an
  `INSERT INTO _guard … SELECT 0 WHERE EXISTS (<the world moved>)` that
  trips a CHECK constraint and aborts the whole batch when the
  precondition went stale. Per-statement `meta.changes` are then asserted.
  The screen turns a refusal into its own sentence: "The pile moved while
  you were reading. Look again, then send."

## The database enforces the product's promises

The submission state machine is a trigger: illegal transitions RAISE and
abort inside SQLite itself, so no code path — not the UI, not MCP, not a
future bug — can move a proposal somewhere the product does not allow.
Room and speaker double-booking refuse the same way, at placement time.
Partial unique indexes hold the subtle rules: one undelivered decision
letter per (submission, decision version), one submitter per proposal.

Decide and release are two separate acts on purpose. `stageDecision`
bumps a per-submission decision version, stages the letter, and cascades
reversals (un-accepting clears placement and cancels the tasks it
created; re-accepting reopens only those). `releaseDecisions` sends a
cohort keyed by (submission, decision version) with the confirmed count
as a guard — a stale letter can never leave, and the number a person
confirms is exactly the number delivered. Email rides after the commit,
real addresses only; the portal is the log of record.

## Identity

One `person` table for everyone. Sign-in is a signed cookie; passwords
are PBKDF2; magic links are HMAC tokens with expiry; Google is the OAuth
code flow. Standing is layered: install-wide `internal_role`, then
per-event `event_role` (owner / approver / editor / viewer) checked at
the query and workflow chokepoints. The green room hangs off a rotating
nonce instead of an account, because the person who needs it is a
volunteer with a lanyard and one bar of signal.

## The demonstration world

`seed/` builds the same world every time — a mulberry32 PRNG with a fixed
seed, exact distribution arithmetic asserted before any wipe (1,000
proposals; 610 decided-and-not-told is a query result, not copy). Reseed
wipes in FK order and rebuilds in about a second, behind a secret. The
cast is synthetic to the last phone number.

## What stays out

No SPA, no ORM, no event bus, no Durable Objects: nothing here needs
coordination beyond what SQLite transactions already give. The roadmap
(embeddings for theming and near-duplicates, AI-drafted letters, inbound
email) is deliberately queued rather than half-present — each lands
behind the same two boundaries when it earns its place.
