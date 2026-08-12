# Product spec

The one-sentence spec: carry every proposal from a stranger's phone to a
room with chairs in it, without the organizer ever guessing who has been
told what.

## The objects

**Event** — a conference: days, timezone, rooms, tracks, a call window,
configurable proposal questions, a decide-by promise, an agenda that is
draft until published, a green-room link, a team.

**Person** — one identity across every event: speaker this year, reviewer
next, organizer someday. Carries only what they chose to share.

**Submission** — a proposal and its whole life: draft → submitted →
(accepted | waitlisted | rejected | withdrawn), accepted ⇄ cancelled.
Every transition the database allows is one the product means. Placement
(room + time) and a public slug arrive only through the agenda builder.

**Review** — one reviewer's scores for one proposal in one round. Staged
until submitted; immutable after; aggregates only ever from submitted
reviews.

**Message** — a letter to a person about a submission. Staged by
deciding, delivered by releasing, versioned so a stale letter dies
instead of leaving.

**Task** — a thing owed: slides, a headshot, travel confirmation. Due
dates, kind completion, and reversal-aware cancellation.

**My schedule / Star / Connection** — an attendee's plan, their opt-in
share of it, and the people it finds them.

## The journeys, and what each one proves

1. **A speaker proposes** — one page, no account, teaching placeholders,
   autosave, conditional questions, a thanks page that promises editing
   and keeps the promise. *(Nothing lost, nobody gatekept.)*
2. **The committee reads** — the pile with true counts, keyboard
   movement, single or bulk staging, a proposal page with everything on
   it. *(Volume without dread.)*
3. **A reviewer scores** — an isolated queue, scores staged privately,
   one deliberate submit, locked after. *(Opinions form freely, then
   count.)*
4. **The organizer tells** — the outbox: read the letters, confirm the
   exact number, send once. Un-deciding restages; nothing ever leaves
   twice. *(The thesis.)*
5. **The agenda takes shape** — click-click placement, conflicts refuse
   at the moment they are created, publish is a named-count act, cancel
   keeps the slot visible and struck. *(The grid tells the truth.)*
6. **The day runs** — green room on a revocable link, now/next per room,
   phones first, slides board behind it. *(Volunteers get superpowers.)*
7. **The audience plans** — agenda, session pages, gallery, stars before
   sign-in, physics warnings, calendar files, embeds. *(Fast beats
   fancy.)*
8. **People find each other** — share your stars, see who else is going,
   reveal only opted-in facts, vanish the moment you change your mind.
9. **Agents walk in** — MCP at `/mcp`: the same reads, the same guarded
   submit, the same polite refusals.

## The registers

Two voices, enforced by a label map: **onstage** (public and speaker
surfaces — warm, second person, dates instead of statuses) and
**backstage** (organizer surfaces — plain speech and true counts). No
internal enum ever prints. Empty states name the next act and link to it.
390px is a design target everywhere, law on day-of surfaces.

## What is deliberately not here yet

Embedding-driven theming and near-duplicate triage, "more like this",
AI-drafted letters (staged, never auto-sent), inbound email onto
submissions, volunteer staffing, dictation into Ask. Queued, not
half-built — the ledger of next moves lives in the build notes.
