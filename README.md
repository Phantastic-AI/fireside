# Fireside

**For conferences run by people with something to say.**

Fireside is an open-source conference program engine: the whole journey from
a public call for speakers to a published agenda — and the quiet operational
truths in between — in one small, fast, warm tool.

Our motto: *make intelligence shine and insights flow.* A conference is an
insight-delivery machine. Fireside's job is carrying each insight intact from
a submitted abstract to a room full of people, and then out into the world.

## Try it now

The live site is **https://onfireside.com** — no password on the
front door. Two conferences are running: **AI Engineer New York 2026**
(mid-drama: a thousand proposals in, six hundred and ten decisions made and
not yet sent) and **DevOps Days Charlotte 2025** (finished, recordings up).

| Way in | Where | Who you are |
| --- | --- | --- |
| The call for speakers | [/aie-nyc/cfp](https://onfireside.com/aie-nyc/cfp) | A hopeful speaker, no account needed |
| The agenda | [/aie-nyc/agenda](https://onfireside.com/aie-nyc/agenda) | Anyone, on one bar of venue wifi |
| My schedule | [/aie-nyc/my-schedule](https://onfireside.com/aie-nyc/my-schedule) | An attendee — stars work before any sign-in |
| The backstage | [/admin](https://onfireside.com/admin) | **naomi@example.org** / **read-them-before-they-go** |
| A finished year | [/ddc-clt](https://onfireside.com/ddc-clt) | Anyone — recordings on the session pages |

That credential is published on purpose: Naomi is the demonstration
organizer, and her conference is reset to the same instant of mid-decision
drama on demand — and automatically, once a day at **09:00 UTC** (2 AM
Pacific). The rebuild is surgical: the demo conferences and their cast reset
to pristine, and whatever you did while signed in as the demo cast resets
with them. Sign up fresh at [/sign-up](https://onfireside.com/sign-up) and
you can start a conference of your own — the form at `/admin/new` takes a
name, days, rooms and tracks, and hands you the keys — and what you create
under your own account is yours: the nightly rebuild never touches it.

Speakers and reviewers in the demonstration cast sign in with magic links;
for `@example.org` addresses the link prints on the page instead of
emailing, so every journey is walkable without an inbox.

Prefer to see the whole thing at a glance? The
[**UX walkthrough**](https://onfireside.com/walkthrough) is every screen, one
after another, filtered by who is using it.

### Sign in as each role

No inbox needed — these demo passwords are published on purpose. **Sign out
between role swaps** (the menu, top right).

| Role | Sign in as | Go here | Do this |
| --- | --- | --- | --- |
| **Organizer** | `naomi@example.org` / `read-them-before-they-go` | `/admin` → [`/admin/aie-nyc/green-room`](https://onfireside.com/admin/aie-nyc/green-room) | Work the accept/waitlist/decline pile; then the outbox (610 letters) and the speaker CRM |
| **Reviewer** | `lena.fischer@example.org` / `score-what-you-read` | [`/admin/aie-nyc/reviews`](https://onfireside.com/admin/aie-nyc/reviews) | The blind reading room — score assigned proposals, names hidden |
| **Speaker** | `dani.okafor@example.org` / `ask-before-you-assume` | [`/aie-nyc/portal`](https://onfireside.com/aie-nyc/portal) | See proposals and what's owed, upload a deck, mark a task |
| **Speaker's helper** | `devika.nair@example.org` / `the-deck-is-handled` | [`/aie-nyc/portal`](https://onfireside.com/aie-nyc/portal) | The same portal, scoped to Priya — send the deck, but never withdraw the talk |
| **Attendee** | `noor.attendee@example.org` / `accept-what-you-choose` | [`/aie-nyc/agenda`](https://onfireside.com/aie-nyc/agenda) + [`/aie-nyc/my-schedule`](https://onfireside.com/aie-nyc/my-schedule) | Star sessions, connect with someone, follow a schedule |
| **Visitor** (anon) | *no login* | [`/aie-nyc`](https://onfireside.com/aie-nyc) · [`/aie-nyc/cfp`](https://onfireside.com/aie-nyc/cfp) · [`/ddc-clt`](https://onfireside.com/ddc-clt) | Browse, submit a talk to the open call, see a finished year with recordings |

**Try the concierge — it does things, not just answers.** Signed in as any
attendee or speaker, open the concierge bubble on an event page and *tell* it
what to do: *"add the load test talk to my schedule"*, then *"take it back
off"*. It resolves what you meant, does it for real, shows the true title, and
gives you a one-tap undo — and a plain question still just gets answered. The
same star/unstar write is available to an external agent over
[MCP](https://onfireside.com/agents) (the `star_session` tool), alongside the
reads, `submit_proposal`, and `submit_review`.

**To walk the attendee tribe** — find someone by name, send a request, and
follow a friend's schedule — sign in as two attendees at once:
**dani.okafor@example.org** / **ask-before-you-assume** and
**noor.attendee@example.org** / **accept-what-you-choose**. Star a session,
open *My schedule → find someone you met*, and connect.

**To walk a speaker's helper** — an assistant who handles the deck and
travel without being on the program — sign in as
**devika.nair@example.org** / **the-deck-is-handled**: she helps Priya, so
her portal becomes Priya's, scoped to what is due (she can send the deck and
mark a task, never withdraw the talk).

**To walk the blind reviewer** — the reading room and nothing else — sign in
as **lena.fischer@example.org** / **score-what-you-read**. Her
queue is only the proposals handed to her, names hidden while she scores,
her marks staying hers until she sends them; the chair reads the weighted
aggregate on the results table, and it is the same number the proposal page
shows.

**For your agent:** the same doors speak MCP at
`https://onfireside.com/mcp` — eight public tools with no session at all,
and fourteen more once a connection acts as you. JSON-RPC 2.0. A proposal submitted by an agent walks through exactly the same
guarded workflow as one typed by hand. Sign in and
[/agents](https://onfireside.com/agents) prints a connect command
whose token acts as you: a reviewer can hand their queue to Claude and file
every review over the wire, through the reviewer's own guards. See
[/agents](https://onfireside.com/agents) for the connect strings.

## What it does

**For organizers**
- A crafted call-for-speakers form with configurable questions, conditional
  fields, autosave that survives a dead battery, and placeholders that teach
  by example
- A submissions desk built for volume: filter chips that are the counts,
  search, keyboard movement, bulk decisions — and an honest answer to
  "who have we decided on but not told yet?"
- **Decide quietly, tell everyone deliberately**: decisions stage letters
  into an outbox; nothing leaves until a person reads the number and sends.
  The number confirmed is the number that goes.
- Review rounds — named, dated, and non-destructive (opening round two never
  hides round one) — where a reviewer's scores stay theirs until they submit,
  then feed a **sortable results table** you can export to CSV; blind is a
  per-round setting. A reviewer works the pile as a **deck of cards**: one
  proposal at a time, next and back, a count of where they are, and a score
  that saves itself as they go. The committee's average is one weighted number,
  said the same on the proposal page and the results table
- **Each conference in its own colour** — a name-and-dates identity band on
  every page it owns, so a speaker in three conferences never confuses one for
  another, or sends a deck to the wrong one
- The call can open in **waves** — an early call, a main call, a late
  extension — and every proposal remembers which one it arrived in
- An agenda builder that surfaces conflicts at the moment of placement —
  a double-booked room or a speaker in two places refuses right there
- A **speaker CRM across conferences**: a directory with filters and saved
  searches, contact notes, duplicate merge, a sourcing board, CSV import,
  and one gesture to invite a past speaker to this year's call — with a
  workflow status (invited → proposed → confirmed → onboarded) that is
  computed from the truth, never a field that can drift from it
- **Deliverables that hold their history**: file requests and the readiness
  board are one system with honest counts; every upload keeps its earlier
  versions; a comment thread runs between organizer and speaker on each file;
  and a files library exports the latest of everything as one ZIP
- Day-of-show surfaces: a phone-first **green room sheet** behind a
  shareable link you can revoke, and a **slides readiness board**
- Per-conference roles — owner, approver, editor, viewer — so a review
  committee can read without the power to send

**For speakers**
- Submit from a phone, edit until the call closes (the older words are
  kept), never lose a word
- A portal that says plainly where things stand and what is needed next —
  and says nothing about decisions that have not been sent
- **Reply with your deck** — a reminder's Reply-To lands the attached slides
  straight on the deliverable, versioned, no app and no sign-in
- **Hand the logistics to a helper** — the deck, the details — without putting
  them on the program; their portal becomes yours, scoped to what is due,
  never able to withdraw the talk
- Withdraw kindly, with the history intact

**For your audience**
- A public agenda, session pages, and a speaker gallery — server-rendered,
  no spinner
- **My schedule**: star talks with no login required — from the agenda, a
  session's own page, or a speaker's — sign in to keep the list on every
  device, share it, and see who else is going; every contact fact opt-in,
  revocable in one click
- **The attendee tribe (AIE++)**: find the people you met by name and connect,
  and **follow a speaker** so that when someone you follow turns up at another
  conference, you hear about it — the beginning of a network that carries
  across events. Double opt-in, and a speaker's page never shows who follows
  them
- A schedule that is honest about physics: overlapping stars and tight
  room-to-room turns say so
- Embeddable agenda and calendar files for the whole program, one session,
  or your own picks
- **Ask** — a concierge that answers with short sentences and working
  doors, never an invented link

## Principles

1. Decide quietly, tell deliberately.
2. People first — a speaker is a person, never a row behind a talk.
3. Nothing dead-ends — every state names the next step.
4. Intelligence at the surfaces, determinism at the core — models draft,
   rank, and explain; only verified workflows change state.
5. Small is a feature — modules on object boundaries, pages that load fast.

## Stack

Cloudflare all the way down: one Worker (server-rendered Hono, no
framework), D1, R2, Workers AI, Email Sending. One deploy command. No SPA,
no build pipeline drama. Every multi-row write is a guarded batch: a
statement that aborts the whole transaction if the world moved while the
human was reading.

About **37,000 lines** of it, and the boundary is real, not aspirational:
routes render and orchestrate, `queries/` owns every read (screens never
write SQL), `workflows/` owns every write (each one a guarded batch), and
one label map holds every word the UI says. The pages carry small
progressive-enhancement islands, so the whole thing works with JavaScript
switched off.

## Run your own

```sh
npm install
npx wrangler d1 create fireside          # then put the id in wrangler.jsonc
for f in schema/0*.sql; do npx wrangler d1 execute fireside --remote --file "$f"; done
npx wrangler secret put SESSION_SECRET   # any long random string
npx wrangler deploy
```

Sign up, start a conference, open the call. Google sign-in and outbound
email each need their own credentials (`GOOGLE_CLIENT_ID` +
`GOOGLE_CLIENT_SECRET`, and an [Email Sending](https://developers.cloudflare.com/email-service/)
domain for `FROM_EMAIL`) — everything else works without them.

## The road

What is deliberately next rather than half-built now: proposal theming and
near-duplicate triage over Workers AI embeddings, "more like this" on
session pages, AI-drafted decision letters (staged for human review, never
auto-sent), inbound email replies landing on submissions, volunteer
staffing, and dictation into the concierge. The ledger lives with the
project's build notes.

## How it scores

Built for the AI Engineer **Kill My SaaS** challenge, and measured against
that challenge's own evaluation kit (sbek) — a browser agent that role-plays
an organizer, reviewer, speaker and attendee through every area and grades
the result. A full seven-area run against the live site:

| Area | Score |
| --- | --- |
| Speaker CRM | 100% |
| Call for Papers | 94.3% |
| AI agenda & schedule | 93.8% |
| Content & deliverables | 91.4% |
| Public & embeddable widgets | 91.4% |
| Speaker management | 81.3% |
| Abstract & review depth | 69.6% |
| **Composite** | **88.2%** |

Weighted across judged rubric items. The kit does not score Fireside's own
additions beyond the brief — the role-aware concierge and the attendee layer
— which are held to the same bar by their own adversarial walkthroughs.

### Re-running the eval

Point the kit at the live site and it runs unattended — the demo world is
pre-seeded, so there is no setup:

- Set the eval config's target `url` to **`https://onfireside.com`**.
- Sign-in is the published organizer above — `naomi@example.org` /
  `read-them-before-they-go`. The other roles have published passwords too (the
  table under *Try it now*), so a scenario can sign in directly rather than sign
  up. A fresh persona can also sign up cold at `/sign-up`: accounts are created
  immediately with a password — no email verification — so nothing blocks on an
  inbox.
- Run the kit (`pnpm run eval`). The areas chain in order against the same
  deployment, the way the kit intends.
- The demo world **rebuilds to its pristine state every day at 09:00 UTC**
  (2 AM Pacific). A full run is well under an hour, so start clear of that
  window and it won't reset under you; the kit is resumable if it ever does.
  The rebuild touches only the demo conferences and cast — accounts and
  conferences an evaluator creates for itself survive it.

## Colophon

The words on every screen were written, then hardened, with
[deslop](https://github.com/Phantastic-AI/deslop) — a small rite that turns a
critic model loose on the copy and lets it judge only what is on the page. Its
one law: a line may be lyrical, but it may not ask the reader to invent the
proposition.

## Status

Building in the open for the AI Engineer **Kill My SaaS** challenge,
August 2026. It would be our earnest pride to be the engine AIE runs on.

## License

Apache-2.0 — see [LICENSE](LICENSE).
