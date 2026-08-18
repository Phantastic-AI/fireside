// The organizer's front door (S-11 screenAdminEvents) and the program
// overview (S-12 screenProgram). Naomi Adeyemi's own two screens: the first
// is where she lands after signing in, the second is where every one of her
// stolen half-hours — 07:10 with coffee, 23:40 with the decisions that must
// go — actually begins. Her walking-in question on both is "who is waiting
// on me?", and the program overview answers it with exactly one loud thing:
// a band at the top, computed fresh from the same counts as everything below
// it, naming the single fact that most needs her right now and the one
// button that acts on it (attnBand — a cascade, not just the decided-not-told
// count it used to be alone). Everything under that band — the eight doors —
// is wayfinding, not competing calls to action: at most one link per card,
// styled quiet, ordered along the conference's own arc (call, review, build,
// day-of, reference) rather than sitting in a grid where thirteen identical
// buttons all shout at once.
//
// The laws this screen is built on:
//   D-025 — every heading parses cold.
//   D-027 — nothing here knows the software is new.
// Neither screen writes anything, so D-024's two-pass rule does not apply —
// there is nothing here to stage or confirm, only doors into the screens
// that do.
//
// Reads are queries/admin.ts `adminEvents()` (both screens — it is also how
// GET /admin/:eventSlug resolves the slug into an event the principal may
// open, since admin.ts exports no direct by-slug lookup) and `pile()` with
// `{ limit: 0 }` for the program overview's counts band, exactly as named in
// the brief for this parcel.
//
// Gaps routed around — the DTOs this file may read do not carry everything
// the prototype's screenProgram shows, so nothing here guesses:
//  - No venue field exists on `AdminEvent`, so the events-index card shows
//    the date range only, where the prototype also names the venue.
//  - `pile(...).counts.decidedNotTold` is one aggregate number. The
//    prototype's attention band also breaks it into accepted/maybe/declined
//    counts (`notToldAccepted` etc.), which no exported query computes —
//    the band here states the total and the door to the outbox, not a
//    breakdown it cannot back with a real count.
//  - The prototype's second and third tiles ("accepted talks to place" vs.
//    already placed, "decks in") need per-submission placement and file-task
//    facts that `pile(..., { limit: 0 })` deliberately withholds (it returns
//    no rows) and that no other exported admin query aggregates. Rather than
//    inventing numbers, the doors into Agenda, People, Green room and
//    Deliverables below carry a plain sentence instead of a count. The same
//    gap caps attnBand's own cascade: "accepted talks are waiting to be
//    placed" is a tier the redesign brief for this band asks for, but with
//    no placement count anywhere in scope, the band skips past it rather
//    than lighting up on a guess — reported, not silently dropped.
//  - The same brief asks the band to also notice proposals nobody has been
//    assigned to read. No exported query aggregates review assignments
//    across an event either — `ProposalReview` lives one proposal at a time,
//    on `Proposal`, which this screen never loads — so that tier is skipped
//    for the identical reason.
//  - `event_role` values ('owner' | 'approver' | 'editor' | 'viewer' |
//    'reviewer') and the install-wide 'organizer' standing have no entry in
//    lib/labels.ts — §6 only tracks the onstage participation roles
//    (speaker/co-speaker/host). The events-index card still needs to show
//    "your standing" per the brief, so it is capitalized locally rather than
//    invented as a new label-map entry this parcel has no authority to add.
//  - The backstageShell `who` field follows the convention already set by
//    the Outbox parcel (src/routes/admin/outbox.ts): the principal's plain
//    name, with no role suffix — not the prototype's hardcoded single-
//    persona "Naomi Adeyemi · Organizer".

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, backstageShell, deniedPage, brand, NAME } from '../../lib/html';
import { label, decidedNotToldPill, CALL_HAPPENED } from '../../lib/labels';
import {
  adminEvents,
  pile,
  ScopeError,
  type AdminEvent,
  type PileCounts,
} from '../../queries/admin';
import { principalFromCookie, type Principal } from '../../workflows/account';
import { createEvent } from '../../workflows/create-event';

/* ------------------------------------------------------------------ *
 * Small words and numbers, local to this screen (the convention set by
 * src/routes/admin/outbox.ts: each backstage route carries its own tiny
 * formatting helpers rather than reaching into a sibling's file).
 * ------------------------------------------------------------------ */

const num = (x: number): string => x.toLocaleString('en-US');
const plural = (x: number, one: string, many: string): string =>
  x === 1 ? `1 ${one}` : `${num(x)} ${many}`;

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((p) => p !== '')
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '·';

/** event_role values, and the install-wide organizer standing. No §6 entry
 *  covers these — see the header note. Plain capitalization, nothing else. */
const STANDING_WORD: Record<string, string> = {
  organizer: 'Organizer',
  owner: 'Owner',
  approver: 'Approver',
  editor: 'Editor',
  viewer: 'Viewer',
  reviewer: 'Reviewer',
};
const standingWord = (s: string): string => STANDING_WORD[s] ?? s;

/** Standings that open into the reading room rather than the organizer's desk.
 *  A reviewer holds nothing else at all; a viewer still reads the organizer's
 *  screens from the nav, and that is unchanged. */
const LANDS_IN_REVIEWS = new Set(['viewer', 'reviewer']);

/* ------------------------------------------------------------------ *
 * Dates, read cold — no timezone conversion for a day key that is already
 * the event's own local day; real timezone math only for an instant.
 * ------------------------------------------------------------------ */

function dayParts(iso: string): { weekday: string; day: number; month: string; year: number } {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
  return {
    weekday: dt.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }),
    day: d ?? 1,
    month: dt.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long' }),
    year: y ?? 1970,
  };
}

function dateRange(startsOn: string, endsOn: string): string {
  const s = dayParts(startsOn);
  const e = dayParts(endsOn);
  if (startsOn === endsOn) return `${s.weekday} ${s.day} ${s.month} ${s.year}`;
  if (s.month === e.month && s.year === e.year) {
    return `${s.weekday} ${s.day} – ${e.weekday} ${e.day} ${s.month} ${s.year}`;
  }
  if (s.year === e.year) {
    return `${s.weekday} ${s.day} ${s.month} – ${e.weekday} ${e.day} ${e.month} ${e.year}`;
  }
  return `${s.weekday} ${s.day} ${s.month} ${s.year} – ${e.weekday} ${e.day} ${e.month} ${e.year}`;
}

/** "20 August" — a stored ISO day, read as its own date. */
function dayMonth(iso: string): string {
  const p = dayParts(iso);
  return `${p.day} ${p.month}`;
}

/** "20 August" — an instant, read in the event's own timezone. */
function dayMonthAt(ms: number, timezone: string): string {
  return new Date(ms).toLocaleDateString('en-US', { timeZone: timezone, day: 'numeric', month: 'long' });
}

/** The call's own state, in the organizer's words (labels.ts §1.7). */
function callStateText(ev: AdminEvent, nowMs: number = Date.now()): string {
  if (ev.lifecycle === 'happened') return CALL_HAPPENED;
  if (ev.lifecycle === 'open' && ev.cfpClosesAt !== null) {
    const days = Math.max(1, Math.ceil((ev.cfpClosesAt - nowMs) / 86_400_000));
    return label('call.open', 'backstage').replace('{n}', String(days));
  }
  if (ev.cfpClosesAt !== null) {
    return label('call.closed', 'backstage').replace('{date}', dayMonthAt(ev.cfpClosesAt, ev.timezone));
  }
  // Never opened is not closed. A conference with no dates on record has no
  // call at all, and saying so is what points its organizer at the one save
  // that starts everything (operator, 2026-08-17).
  return label('call.none', 'backstage');
}

/* ------------------------------------------------------------------ *
 * The top bar for the one screen with no event to anchor it — brand and
 * identity only, the same markup backstageShell renders for `.bs-me`.
 * ------------------------------------------------------------------ */

function topBar(principal: Principal): string {
  return (
    '<div class="bs-top"><div class="wrap wrap-wide bs-top-in">' +
    brand() +
    '<div class="bs-me"><span style="width:26px;height:26px;border-radius:50%;display:inline-grid;' +
    'place-items:center;background:var(--ember-wash);color:var(--ember);font-size:11px;' +
    `font-weight:700">${esc(initialsOf(principal.name))}</span><span>${esc(principal.name)}</span>` +
    `<a href="/sign-out" style="color:#CFC5B6;text-decoration:underline;text-underline-offset:2px">${esc(label('auth.sign_out', 'backstage'))}</a></div>` +
    '</div></div>'
  );
}

/* ------------------------------------------------------------------ *
 * S-11 — GET /admin — your events
 * ------------------------------------------------------------------ */

function eventCard(ev: AdminEvent): string {
  const slug = encodeURIComponent(ev.slug);
  const dot = ev.lifecycle === 'open' ? '' : ' closed';
  // A pure reviewer's card is a door to her own room — no decision facts,
  // which are the organizer's weather, not hers.
  if (LANDS_IN_REVIEWS.has(ev.standing)) {
    return (
      `<a class="card evcard" href="/admin/${slug}/reviews">` +
      `<h3>${esc(ev.name)}</h3>` +
      `<div class="when">${esc(dateRange(ev.startsOn, ev.endsOn))} · ${esc(standingWord(ev.standing))}</div>` +
      `<div class="state"><span class="dot${dot}"></span>${esc(callStateText(ev))}</div>` +
      '<div class="cta"><span class="btn btn-primary">Open your reviews</span></div>' +
      '</a>'
    );
  }
  const chip =
    ev.counts.decidedNotTold > 0
      ? `<div class="chip notold">${esc(decidedNotToldPill(ev.counts.decidedNotTold))}</div>`
      : '<div class="chip s-accepted">Everyone has been notified</div>';
  return (
    `<a class="card evcard" href="/admin/${slug}">` +
    `<h3>${esc(ev.name)}</h3>` +
    `<div class="when">${esc(dateRange(ev.startsOn, ev.endsOn))} · ${esc(standingWord(ev.standing))}</div>` +
    `<div class="state"><span class="dot${dot}"></span>${esc(callStateText(ev))}</div>` +
    '<div class="sub">' +
    `${esc(num(ev.counts.proposals))} proposals · ${esc(num(ev.counts.accepted))} accepted · ` +
    `${esc(num(ev.counts.undecided))} undecided</div>` +
    chip +
    '<div class="cta"><span class="btn btn-primary">Open the program</span></div>' +
    '</a>'
  );
}

function adminEventsPage(principal: Principal, events: AdminEvent[]): string {
  const totalProposals = events.reduce((sum, e) => sum + e.counts.proposals, 0);
  const lede =
    `${plural(events.length, 'conference', 'conferences')} you can open. ` +
    `${plural(totalProposals, 'proposal', 'proposals')} ${events.length === 1 ? 'on it' : 'between them'}.`;
  const body =
    '<div class="stage backstage">' +
    topBar(principal) +
    '<main><div class="wrap" style="padding-top:44px">' +
    '<div style="display:flex;align-items:baseline;gap:16px;flex-wrap:wrap"><h1 class="display">Your events</h1>' +
    // The speaker database spans every conference, so it lives here on the
    // events picker rather than inside one event's nav.
    '<a class="link" href="/admin/crm" style="margin-left:auto">Speaker database →</a>' +
    '<a class="link" href="/admin/new">Start a conference →</a></div>' +
    `<p class="lede" style="margin-top:8px">${esc(lede)}</p>` +
    `<div class="sec evcards">${events.map(eventCard).join('')}</div>` +
    '</div></main>' +
    `<footer class="foot"><div class="wrap foot-in"><span class="fname">${NAME}</span></div></footer>` +
    '</div>';
  return page({ title: `Your events · ${NAME}`, register: 'backstage', body });
}

/** The first-day state: no events yet, and the one door that fixes it. */
function noConferencesPage(principal: Principal): string {
  const body =
    '<div class="stage backstage">' +
    topBar(principal) +
    '<main><div class="wrap" style="padding-top:44px">' +
    '<h1 class="display">Your events</h1>' +
    '<div class="sec state-out">' +
    '<h2>No conferences yet.</h2>' +
    '<p>Start one and you own it — or, if a conference is already running, ask its organizer to add you as a team member.</p>' +
    '<a class="btn btn-primary" href="/admin/new" style="margin-top:14px">Start a conference →</a>' +
    '</div></div></main>' +
    `<footer class="foot"><div class="wrap foot-in"><span class="fname">${NAME}</span></div></footer>` +
    '</div>';
  return page({ title: `Your events · ${NAME}`, register: 'backstage', body });
}

/* ------------------------------------------------------------------ *
 * GET/POST /admin/new — starting a conference
 * ------------------------------------------------------------------ */

type NewEventValues = Record<string, string>;

function field(labelText: string, inner: string, hint?: string): string {
  return (
    `<div style="margin-top:16px"><label style="display:block;font-size:13.5px;font-weight:650;margin-bottom:5px">${esc(labelText)}</label>` +
    inner +
    (hint ? `<p class="sub" style="margin-top:4px;font-size:13px">${esc(hint)}</p>` : '') +
    '</div>'
  );
}

const inputStyle =
  'style="width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;font:inherit;font-size:15px;background:var(--card)"';

function newEventPage(principal: Principal, error?: string, v: NewEventValues = {}): string {
  const val = (k: string, fallback = '') => esc(v[k] ?? fallback);
  const body =
    '<div class="stage backstage">' +
    topBar(principal) +
    '<main><div class="wrap" style="padding-top:44px;max-width:640px">' +
    '<h1 class="display">Start a conference</h1>' +
    '<p class="lede" style="margin-top:8px">Name it, give it days and rooms, and the rest is settings.</p>' +
    (error ? `<div class="card card-pad" style="margin-top:16px;border-color:var(--danger)"><p style="margin:0">${esc(error)}</p></div>` : '') +
    '<form method="post" action="/admin/new" class="sec">' +
    field('Name', `<input name="name" required maxlength="120" value="${val('name')}" ${inputStyle}>`) +
    field(
      'Address',
      `<input name="slug" maxlength="48" value="${val('slug')}" placeholder="leave it blank and it comes from the name" ${inputStyle}>`,
      'Lowercase letters, digits and dashes — the public page lives at /that-address.'
    ) +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
    field('First day', `<input type="date" name="starts_on" required value="${val('starts_on')}" ${inputStyle}>`) +
    field('Last day', `<input type="date" name="ends_on" required value="${val('ends_on')}" ${inputStyle}>`) +
    '</div>' +
    field(
      'Timezone',
      `<input name="timezone" required list="tz-list" value="${val('timezone', 'America/New_York')}" ${inputStyle}>` +
        '<datalist id="tz-list">' +
        ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney', 'UTC']
          .map((z) => `<option value="${z}">`)
          .join('') +
        '</datalist>'
    ) +
    field('Venue', `<input name="venue_name" maxlength="120" value="${val('venue_name')}" ${inputStyle}>`) +
    field(
      'The call for speakers',
      `<label style="display:flex;gap:8px;align-items:center;font-size:15px;font-weight:400"><input type="checkbox" name="call_open" value="1"${v['call_open'] ? ' checked' : ''}> Open it now</label>` +
        `<div style="margin-top:10px"><input type="date" name="cfp_closes_on" value="${val('cfp_closes_on')}" ${inputStyle}></div>`,
      'Tick it and set the closing date, and speakers can send proposals the moment this conference exists. Leave it and there is no call yet — you open one from Settings when you are ready. You can split it into waves, an early call and a late extension, later.'
    ) +
    field('Decisions go out by', `<input type="date" name="decide_by" value="${val('decide_by')}" ${inputStyle}>`, 'Shown to speakers on the form and in their portal.') +
    field('A line for the call page', `<textarea name="cfp_intro" rows="3" maxlength="1200" ${inputStyle}>${val('cfp_intro')}</textarea>`) +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
    field('Rooms, one per line', `<textarea name="rooms" rows="4" ${inputStyle}>${val('rooms', 'Main stage')}</textarea>`) +
    field('Tracks, one per line', `<textarea name="tracks" rows="4" ${inputStyle}></textarea>`, 'Leave empty to run without tracks.') +
    '</div>' +
    '<div class="btnrow" style="margin-top:22px"><button class="btn btn-primary btn-lg" type="submit">Start it</button>' +
    '<a class="btn" href="/admin">Back to your events</a></div>' +
    '</form>' +
    '</div></main>' +
    `<footer class="foot"><div class="wrap foot-in"><span class="fname">${NAME}</span></div></footer>` +
    '</div>';
  return page({ title: `Start a conference · ${NAME}`, register: 'backstage', body });
}

/* ------------------------------------------------------------------ *
 * S-12 — GET /admin/:eventSlug — the program overview
 * ------------------------------------------------------------------ */

/** The five-state band the brief names, in order: total, then the three
 *  decision outcomes, then still-open, then the one outside the funnel. */
function countsBand(counts: PileCounts): string {
  const cell = (n: number, word: string) => `${esc(num(n))} ${esc(word.toLowerCase())}`;
  return (
    '<p class="counts">' +
    `<b>${esc(num(counts.all))} proposals</b>` +
    `<span class="sep">·</span>${cell(counts.accepted, label('submission.accepted', 'backstage'))}` +
    `<span class="sep">·</span>${cell(counts.maybe, label('submission.waitlisted', 'backstage'))}` +
    `<span class="sep">·</span>${cell(counts.declined, label('submission.rejected', 'backstage'))}` +
    `<span class="sep">·</span>${cell(counts.undecided, label('submission.submitted', 'backstage'))}` +
    `<span class="sep">·</span>${cell(counts.withdrawn, label('submission.withdrawn', 'backstage'))}` +
    '</p>'
  );
}

/**
 * The one loud thing on the page — a cascade run in the order Naomi's own
 * "what needs me" runs, stopping at the first tier that is true and painting
 * exactly one primary/filled button for it, the only one anywhere on the
 * screen:
 *   1. a decision made and not yet told — the loudest fact there is, because
 *      a stale "decided" costs trust the moment somebody notices (unchanged
 *      from before this redesign — pile.ts's own outbox band mirrors it);
 *   2. otherwise, a pile she can still act on: proposals waiting on a call
 *      that has already closed, so nothing new is coming to change her mind;
 *   3. otherwise, with the call itself still open, there is nothing to
 *      decide yet — a quiet status line, not a colored band, says so;
 *   4. otherwise, nothing pending anywhere — the calm state, in the exact
 *      words pile.ts's own outbox band already uses for the same fact.
 * Two tiers the redesign brief for this band also names — proposals still
 * needing a reader, and accepted talks not yet placed — are skipped rather
 * than guessed at; see the header note for why neither count exists yet.
 */
function attnBand(ev: AdminEvent, counts: PileCounts): string {
  const slug = encodeURIComponent(ev.slug);

  // A conference with no call dates cannot be sent a single talk, and nothing
  // on this page said so — the one action a brand-new conference needs was
  // unmarked, and an organizer had to find two undated fields in settings to
  // start. It goes first, above everything, because until it is done nothing
  // else on this page can happen (operator, 2026-08-17).
  if (ev.cfpClosesAt === null && counts.all === 0) {
    return (
      '<div class="sec attn">' +
      '<div class="n">1</div>' +
      '<div><div class="lab">No call for speakers yet</div>' +
      '<div class="why">Nobody can send you a talk until the call has an opening and a ' +
      'closing date. It takes one save.</div></div>' +
      `<a class="btn btn-primary go" href="/admin/${slug}/settings#the-event">Open the call →</a>` +
      '</div>'
    );
  }

  const notTold = counts.decidedNotTold;
  if (notTold > 0) {
    return (
      '<div class="sec attn">' +
      `<div class="n">${esc(num(notTold))}</div>` +
      `<div><div class="lab">${esc(label('submission.decided_not_told', 'backstage'))}</div>` +
      '<div class="why">Nothing has gone out yet.</div></div>' +
      `<a class="btn btn-primary go" href="/admin/${slug}/outbox">Send the letters →</a>` +
      '</div>'
    );
  }

  if (counts.undecided > 0 && ev.lifecycle !== 'open') {
    return (
      '<div class="sec attn">' +
      `<div class="n">${esc(num(counts.undecided))}</div>` +
      '<div><div class="lab">Still undecided</div>' +
      '<div class="why">The call isn\'t taking new proposals — these are the only ones ' +
      'waiting on you.</div></div>' +
      `<a class="btn btn-primary go" href="/admin/${slug}/submissions?f=undecided">Decide the pile →</a>` +
      '</div>'
    );
  }

  if (ev.lifecycle === 'open') {
    // Neutral, not colored — nothing here is wrong or resolved, only ongoing.
    return (
      '<div class="sec attn" style="background:var(--card);border-color:var(--line)">' +
      `<div class="n">${esc(num(ev.counts.proposals))}</div>` +
      '<div><div class="lab">In so far</div>' +
      '<div class="why">The call is still open. More may come in before it closes.</div></div>' +
      `<a class="btn go" href="/admin/${slug}/submissions">Watch the call →</a>` +
      '</div>'
    );
  }

  return (
    '<div class="sec attn" style="background:var(--go-wash);border-color:#CBE0D1">' +
    '<div class="n">0</div>' +
    '<div><div class="lab">Everyone has been notified</div></div>' +
    `<a class="btn go" href="/admin/${slug}/submissions">Go to proposals →</a>` +
    '</div>'
  );
}

function tile(big: string, lab: string, sub: string, href: string, cta: string): string {
  return (
    '<div class="card card-pad">' +
    `<div class="display" style="font-size:34px;line-height:1">${esc(big)}</div>` +
    `<div style="font-weight:640;margin-top:4px">${esc(lab)}</div>` +
    `<div class="sub" style="margin-top:2px">${esc(sub)}</div>` +
    `<p style="margin:12px 0 0"><a class="link" href="${esc(href)}">${esc(cta)} →</a></p>` +
    '</div>'
  );
}

/** "Open reviews" → "Open reviews →" — but a label that already carries its
 *  own arrow (the public-page "↗" convention — see backstageShell's own
 *  "See the public page ↗") keeps that one arrow rather than gaining a
 *  second, unrelated one. */
const withArrow = (label: string): string => (/[→↗]$/.test(label) ? label : `${label} →`);

/** Wayfinding, not a call to action — one quiet link per card (the same
 *  `.link` style `tile()` already uses for Proposals, below), plus a small
 *  second line when a card genuinely has two doors. Never `.btn`: that
 *  weight is spent once, at the top, by attnBand. */
function doorCard(
  title: string,
  sub: string,
  primary: { href: string; label: string },
  secondary?: { href: string; label: string }
): string {
  return (
    '<div class="card card-pad">' +
    `<h3 style="font-weight:660">${esc(title)}</h3>` +
    `<p class="sub" style="margin:6px 0 12px">${esc(sub)}</p>` +
    `<p style="margin:0"><a class="link" href="${esc(primary.href)}">${esc(withArrow(primary.label))}</a></p>` +
    (secondary
      ? `<p style="margin:8px 0 0"><a class="link" style="font-size:13px" href="${esc(secondary.href)}">${esc(withArrow(secondary.label))}</a></p>`
      : '') +
    '</div>'
  );
}

function programPage(
  principal: Principal,
  ev: AdminEvent,
  counts: PileCounts,
  speakerNotes: { text: string; asked_at: number }[] = []
): string {
  const slug = encodeURIComponent(ev.slug);
  const decideByLine = ev.decideBy
    ? `<p class="sub" style="margin-top:6px">Decide by ${esc(dayMonth(ev.decideBy))}.</p>`
    : '';

  // Ordered along the conference's own arc — call, review, build, day-of,
  // reference — so the eye moves the way the work actually happens instead
  // of landing on a grid with no story. Files and Settings, the two doors
  // that are pure reference rather than a phase of the work, sit quiet at
  // the end.
  const doors =
    tile(
      num(counts.all),
      'proposals',
      `${num(counts.undecided)} still ${label('submission.submitted', 'backstage').toLowerCase()}`,
      `/admin/${slug}/submissions`,
      'Open the list'
    ) +
    doorCard(
      'Reviews',
      "Your committee's scores, round by round.",
      { href: `/admin/${slug}/reviews`, label: 'Open reviews' },
      { href: `/admin/${slug}/reviews/results`, label: 'See results' }
    ) +
    doorCard(
      'Agenda',
      ev.agendaPublished ? 'The agenda is public.' : 'Scheduled sessions are not public yet.',
      { href: `/admin/${slug}/agenda`, label: 'Open the builder' },
      { href: `/${slug}/agenda`, label: 'See it as the public does ↗' }
    ) +
    doorCard('People', 'Everyone confirmed to speak, and what they still owe you.', {
      href: `/admin/${slug}/people`,
      label: 'Open people',
    }) +
    doorCard('Deliverables', 'What was asked for, and who still owes it.', {
      href: `/admin/${slug}/slides`,
      label: 'Open deliverables',
    }) +
    doorCard('Green room', 'The day-of sheet for your crew.', {
      href: `/admin/${slug}/green-room`,
      label: 'Open green room',
    }) +
    doorCard('Files', 'Every file sent in, in one place.', {
      href: `/admin/${slug}/files`,
      label: 'Open files',
    }) +
    doorCard('Settings', 'Team, dates, and the call itself.', {
      href: `/admin/${slug}/settings`,
      label: 'Open settings',
    });

  const body =
    '<div style="padding:26px 0 0">' +
    `<h1 class="display">${esc(ev.name)}</h1>` +
    `<p class="sub" style="margin-top:6px">${esc(dateRange(ev.startsOn, ev.endsOn))} · ` +
    `${esc(callStateText(ev))}${ev.tzLabel ? ` · ${esc(ev.tzLabel)}` : ''}</p>` +
    '</div>' +
    attnBand(ev, counts) +
    (speakerNotes.length > 0
      ? '<div class="sec"><div class="card card-pad">' +
        '<h3 class="serif" style="font-size:18px;font-weight:600">From the speakers</h3>' +
        '<p class="sub" style="margin:2px 0 8px">Change requests sent from settled talks.</p>' +
        speakerNotes
          .map(
            (n) =>
              `<p style="margin:8px 0 0;border-top:1px solid var(--line-soft);padding-top:8px">${esc(n.text)} ` +
              `<span class="sub">· ${esc(dayMonthAt(n.asked_at, ev.timezone))}</span></p>`
          )
          .join('') +
        '</div></div>'
      : '') +
    `<div class="sec"><div class="card card-pad">${countsBand(counts)}${decideByLine}</div></div>` +
    `<div class="sec" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:16px">${doors}</div>`;

  return page({
    title: `${ev.name} · ${NAME}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: ev.slug,
      eventName: ev.name,
      here: '',
      who: principal.name,
      whoInitials: initialsOf(principal.name),
      tzLabel: ev.tzLabel ?? ev.timezone,
      body,
    }),
  });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

export function registerAdminHome(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in');

    try {
      const events = await adminEvents(c.env.DB, principal);
      return c.html(adminEventsPage(principal, events));
    } catch (e) {
      // adminEvents throws exactly this when the principal holds no event
      // role at all and is not an install-wide organizer — the brief's calm
      // first-day state, not a denial of something they tried to reach.
      if (e instanceof ScopeError) return c.html(noConferencesPage(principal));
      throw e;
    }
  });

  // Registered before /admin/:eventSlug so the literal wins the match.
  app.get('/admin/new', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');
    return c.html(newEventPage(principal));
  });

  app.post('/admin/new', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');
    const form = await c.req.parseBody();
    const s = (k: string): string => (typeof form[k] === 'string' ? (form[k] as string) : '');
    const lines = (k: string): string[] =>
      s(k)
        .split('\n')
        .map((x) => x.trim())
        .filter((x) => x !== '');
    const res = await createEvent(c.env.DB, principal, {
      name: s('name'),
      slug: s('slug'),
      startsOn: s('starts_on'),
      endsOn: s('ends_on'),
      timezone: s('timezone'),
      venueName: s('venue_name'),
      callOpen: s('call_open') === '1',
      cfpClosesOn: s('cfp_closes_on'),
      decideBy: s('decide_by'),
      cfpIntro: s('cfp_intro'),
      rooms: lines('rooms'),
      tracks: lines('tracks'),
    });
    if (!res.ok) {
      const kept: Record<string, string> = {};
      for (const k of ['name', 'slug', 'starts_on', 'ends_on', 'timezone', 'venue_name', 'call_open', 'cfp_closes_on', 'decide_by', 'cfp_intro', 'rooms', 'tracks']) {
        kept[k] = s(k);
      }
      return c.html(newEventPage(principal, res.error, kept), 422);
    }
    return c.redirect(`/admin/${res.slug}`, 303);
  });

  app.get('/admin/:eventSlug', async (c) => {
    const principal = await principalFromCookie(
      c.env.DB,
      c.env.SESSION_SECRET,
      c.req.header('cookie')
    );
    if (!principal) return c.redirect('/sign-in');

    const slug = c.req.param('eventSlug');
    try {
      const events = await adminEvents(c.env.DB, principal);
      const ev = events.find((e) => e.slug === slug);
      if (!ev) {
        // A conference that does not exist at all is a missing page, not a
        // permission wall — event slugs are public on the front of the site.
        const exists = await c.env.DB.prepare('SELECT 1 FROM event WHERE slug = ?').bind(slug).first();
        if (!exists) return c.notFound();
        return c.html(deniedPage(), 403);
      }
      // A pure reviewer's landing is her own room, not the organizer's desk —
      // and for the 'reviewer' standing it is the only room there is.
      if (LANDS_IN_REVIEWS.has(ev.standing)) return c.redirect(`/admin/${ev.slug}/reviews`);
      const { counts } = await pile(c.env.DB, principal, ev.id, 'all', { limit: 0 });
      // T609 — notes speakers sent from their settled talks, newest first.
      const notesRes = await c.env.DB
        .prepare(
          `SELECT text, asked_at FROM question
            WHERE event_id = ?1 AND scope = 'speaker' AND answered = 0
            ORDER BY asked_at DESC LIMIT 5`
        )
        .bind(ev.id)
        .all<{ text: string; asked_at: number }>();
      return c.html(programPage(principal, ev, counts, notesRes.results ?? []));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(), 403);
      throw e;
    }
  });
}
