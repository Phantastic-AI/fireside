# Fireside: fresh-eyes design review

_Opinionated pass after walking the public event, CFP, agenda, talk, speakers,
Ask, agents, past event, and organizer backstage surfaces at desktop and 390px._

## The verdict

Fireside now has a real point of view. It feels like an event operating system
with editorial taste, not another conference form builder.

Its best idea is not the concierge. It is visible consequence management:

> Attention state → context → action.

The product shows what is moving, what is stuck, who owns it, and what happens
next. That is the thing to protect.

The primary audience is clear: the lead organizer and event owner. Volunteers
are the daily operators. Attendees and speakers are the proof that the system
made the event better.

## Keep these things

- The warm paper, ink, and ember palette. The serif/sans pairing gives the
  product a confident editorial register without becoming precious.
- The split between onstage and backstage. Public pages can be warm and
  invitational; organizer pages should stay plain, exact, and count-driven.
- Copy that names real pressure: 1,000 proposals, unassigned reviews,
  decisions not yet notified, sessions still to place.
- The workflow chain: call for speakers → reviews → decisions → agenda →
  green room. It is a product story told through actual work.
- The outbox, proposal detail, organizer agenda, and green room. These are the
  most convincing surfaces because they make the promise tangible.

## Do next, in order

### 0. Make the walkthrough trustworthy

The local app currently fails after reload with `D1_ERROR: no such column:
e.submission_windows`. The query in `src/queries/public.ts` expects a field
from `schema/0005_submission_waves.sql`, but the local database has not been
migrated.

This is a design issue in practice. If the conference disappears on reload,
no visual polish can be judged reliably.

### 1. Treat 390px as a composition, not a breakpoint

Do not shrink the desktop layouts until they fit.

- Public and organizer agenda: show one room at a time with a room switcher,
  time rail, and clear now/next marker. Never compress five rooms into a tiny
  spreadsheet.
- Reviews: turn the assignment table into reviewer cards with assigned,
  completed, and unassigned counts.
- Speakers: prioritize name, talk, and affiliation. Let track and company
  become quiet metadata.
- Sticky bulk actions: reserve their own bottom space and never collide with
  the concierge bubble or the mobile keyboard.

### 2. Make the product feel live

Give each important page one live object. Not another card. One moving fact:

- Homepage: `610 decisions ready to send`
- Reviews: `327 proposals still need a reader`
- Agenda: `Next session in 8 minutes`
- Green room: `Tomás is next in Ballroom A`
- Outbox: `Last prepared 4 minutes ago`

This is the sparkle. Fireside should feel like a calm control room for a live
event, not a gallery of SaaS screens.

### 3. Clarify the information architecture

The metaphorical labels are charming, but some slow scanning: `The event`,
`The call`, `My schedule`, `Your portal`, `Concierge`.

Keep the personality in section titles and copy. Make the core navigation a
little more literal: `Event`, `Call for speakers`, `Schedule`, `Ask`, `Portal`.

The homepage also has two voices in its navigation: `Program`, `Team`, and
`Attendees` beside `Walk one` and `Concierge`. Make `Walk one` one strong
editorial invitation rather than another permanent destination.

### 4. Give Ask and Concierge different jobs

- **Ask** is the full program query surface, with richer browsing and history.
- **Concierge** is the contextual doorway available from wherever someone is.

Treat Concierge as core connective tissue, not as a separate chatbot product.
The SaaS remains the source of truth and the place where state is reviewed and
committed. Concierge is the fastest way through that system. MCP is the power
layer for deeper operator workflows, not a requirement for ordinary users.

The concierge should offer situational prompts, not generic chat theater:

> Find me a practical session after lunch.

> Show me undecided proposals with no assigned reader.

Keep the suggested questions short and excellent. Three strong prompts beat a
wall of pills.

## Taste rules for the next pass

- Use color semantically. Ember means act; yellow means attention; muted ink
  means context. Do not add colors just to decorate.
- Let pages breathe. Not every paragraph needs a bordered card. Use rules,
  whitespace, and one asymmetric moment per page.
- Keep motion short and reliable. A hero that is still faded during capture
  reads as unfinished.
- Preserve real names, talk titles, and concrete descriptions. Do not add
  generic AI portraits, glass effects, gradients, 3D objects, or confetti.
- Add team handoff language where it helps: `Waiting on Alex`, `Last touched
  by Naomi`, `No one owns these yet`.
- Make the green-room link's scope obvious: who can access it, what it reveals,
  and how it can be rotated.

## Defaults for the next pass

- What is the primary homepage action: explore a live event, start a CFP, or
  sign in?
- How much event identity should sit on top of the Fireside shell?
- What must be visible above the fold at 390px for each secondary hat:
  attendee, speaker, reviewer, organizer?

For Concierge, the default is already clear: make it damn useful, keep the
underlying SaaS legible, and let the hybrid relationship be the differentiator.

## The strong opinion

Do not make Fireside louder. Make it more awake.

The design already has enough style. Its advantage is the feeling that the
conference is moving, someone is watching the right thing, and nothing
important is about to fall through the cracks.

No product files were changed for this review.
