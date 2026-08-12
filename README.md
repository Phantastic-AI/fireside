# Fireside

**For conferences run by people with something to say.**

Fireside is an open-source conference program engine: the whole journey from
a public call for speakers to a published agenda — and the quiet operational
truths in between — in one small, fast, warm tool.

Our motto: *make intelligence shine and insights flow.* A conference is an
insight-delivery machine. Fireside's job is carrying each insight intact from
a submitted abstract to a room full of people, and then out into the world.

## What it does

**For organizers**
- A crafted call-for-speakers form with conditional fields, draft resume
  links, and placeholders that teach by example
- A submissions desk built for volume: filters, scoring, bulk decisions —
  and an honest answer to "who have we decided on but not told yet?"
- **Decide quietly, tell everyone deliberately**: decisions stage messages
  into an outbox; nothing leaves until you say so
- An agenda builder that surfaces conflicts at the moment of placement,
  with an AI draft to start from
- A **cross-conference speaker directory**: every speaker you've ever worked
  with, their history, one place
- Day-of-show surfaces: a phone-first **green room sheet** and a **slides
  readiness board**

**For speakers**
- Submit from a phone, resume a draft from a link, never lose a word
- A portal that says plainly where things stand and what's needed next
- Profile and headshot you control

**For your audience**
- A public agenda, session pages, and a speaker gallery with faces
- **My Schedule**: star talks with no login required; sign in (magic link or
  Google) to keep it, share it, and mark what you saw — with a watch-later
  list for what you missed
- Embeddable widgets and calendar files that just work

**The Program Brain** (Cloudflare Workers AI)
- Cluster triage: "127 proposals · 11 themes · 3 near-duplicates"
- Semantic search that understands questions, not keywords
- "More like this" on every session
- Draft-with-AI decision letters — staged for human review, never auto-sent
- A concierge that answers visitors, attendees, and organizers alike —
  each within their own scope

## Principles

1. Decide quietly, tell deliberately.
2. People first — a speaker is a person, never a row behind a talk.
3. Nothing dead-ends — every state names the next step.
4. Intelligence at the surfaces, determinism at the core — models draft,
   rank, and explain; only verified workflows change state.
5. Small is a feature — modules on object boundaries, pages that load fast.

## Stack

Cloudflare all the way down: Workers (server-rendered Hono) · D1 · R2 ·
Workers AI. One deploy command. No SPA, no build pipeline drama.

## Status

Building in the open for the AI Engineer **Kill My SaaS** challenge,
August 2026. It would be our earnest pride to be the engine AIE runs on.

## License

Apache-2.0 — see [LICENSE](LICENSE).
