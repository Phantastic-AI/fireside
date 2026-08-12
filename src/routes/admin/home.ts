// The organizer's front door (S-11 screenAdminEvents) and the program
// overview (S-12 screenProgram). Naomi Adeyemi's own two screens: the first
// is where she lands after signing in, the second is where every one of her
// stolen half-hours — 07:10 with coffee, 23:40 with the decisions that must
// go — actually begins. Her walking-in question on both is "who is waiting
// on me?", and the loudest thing on the program overview is always the
// decided-but-not-told count, because a count that lies once means she
// re-checks everything forever.
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
//    inventing numbers, the doors into Agenda, People, Green room and Slides
//    below carry a plain sentence instead of a count.
//  - `event_role` values ('owner' | 'approver' | 'editor' | 'viewer') and
//    the install-wide 'organizer' standing have no entry in lib/labels.ts —
//    §6 only tracks the onstage participation roles (speaker/co-speaker/
//    host). The events-index card still needs to show "your standing" per
//    the brief, so it is capitalized locally rather than invented as a new
//    label-map entry this parcel has no authority to add.
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
};
const standingWord = (s: string): string => STANDING_WORD[s] ?? s;

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
  // No closing instant on record at all — the same sentence, minus the date
  // clause, rather than a guessed one.
  return label('call.closed', 'backstage').replace(' {date}', '');
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
    `font-weight:700">${esc(initialsOf(principal.name))}</span><span>${esc(principal.name)}</span></div>` +
    '</div></div>'
  );
}

/* ------------------------------------------------------------------ *
 * S-11 — GET /admin — your events
 * ------------------------------------------------------------------ */

function eventCard(ev: AdminEvent): string {
  const slug = encodeURIComponent(ev.slug);
  const dot = ev.lifecycle === 'open' ? '' : ' closed';
  const chip =
    ev.counts.decidedNotTold > 0
      ? `<div class="chip notold">${esc(decidedNotToldPill(ev.counts.decidedNotTold))}</div>`
      : '<div class="chip s-accepted">Everyone has been told</div>';
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
    '<h1 class="display">Your events</h1>' +
    `<p class="lede" style="margin-top:8px">${esc(lede)}</p>` +
    `<div class="sec evcards">${events.map(eventCard).join('')}</div>` +
    '</div></main>' +
    `<footer class="foot"><div class="wrap foot-in"><span class="fname">${NAME}</span></div></footer>` +
    '</div>';
  return page({ title: `Your events · ${NAME}`, register: 'backstage', body });
}

/** The brief's calm first-day state: no events at all, and creating one is
 *  not built yet. One sentence, deliberately no door — see the header note. */
function noConferencesPage(principal: Principal): string {
  const body =
    '<div class="stage backstage">' +
    topBar(principal) +
    '<main><div class="wrap" style="padding-top:44px">' +
    '<h1 class="display">Your events</h1>' +
    '<div class="sec state-out">' +
    '<h2>No conferences yet.</h2>' +
    '<p>If you should be running one, ask whoever set it up to add you as a team member.</p>' +
    '</div></div></main>' +
    `<footer class="foot"><div class="wrap foot-in"><span class="fname">${NAME}</span></div></footer>` +
    '</div>';
  return page({ title: `Your events · ${NAME}`, register: 'backstage', body });
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

/** The loudest fact on the page — the decided-not-told count, or the calm
 *  green state once every decision has reached the person it is about. */
function attnBand(ev: AdminEvent, counts: PileCounts): string {
  const slug = encodeURIComponent(ev.slug);
  const n = counts.decidedNotTold;
  if (n > 0) {
    return (
      '<div class="sec attn">' +
      `<div class="n">${esc(num(n))}</div>` +
      `<div><div class="lab">${esc(label('submission.decided_not_told', 'backstage'))}</div>` +
      '<div class="why">Nothing has gone out yet.</div></div>' +
      `<a class="btn btn-primary go" href="/admin/${slug}/outbox">Read them →</a>` +
      '</div>'
    );
  }
  return (
    '<div class="sec attn" style="background:var(--go-wash);border-color:#CBE0D1">' +
    '<div class="n">0</div>' +
    '<div><div class="lab">Everyone has been told</div>' +
    '<div class="why">Every decision you have made has reached the person it is about.</div></div>' +
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

function doorCard(title: string, sub: string, links: { href: string; label: string }[]): string {
  return (
    '<div class="card card-pad">' +
    `<h3 style="font-weight:660">${esc(title)}</h3>` +
    `<p class="sub" style="margin:6px 0 12px">${esc(sub)}</p>` +
    '<div class="btnrow">' +
    links.map((l) => `<a class="btn" href="${esc(l.href)}">${esc(l.label)}</a>`).join('') +
    '</div></div>'
  );
}

function programPage(principal: Principal, ev: AdminEvent, counts: PileCounts): string {
  const slug = encodeURIComponent(ev.slug);
  const decideByLine = ev.decideBy
    ? `<p class="sub" style="margin-top:6px">Decide by ${esc(dayMonth(ev.decideBy))}.</p>`
    : '';

  const doors =
    tile(
      num(counts.all),
      'proposals',
      `${num(counts.undecided)} still ${label('submission.submitted', 'backstage').toLowerCase()}`,
      `/admin/${slug}/submissions`,
      'Open the list'
    ) +
    doorCard('Reviews', "Your committee's scores, round by round.", [
      { href: `/admin/${slug}/reviews`, label: 'Open reviews' },
    ]) +
    doorCard(
      'Agenda',
      ev.agendaPublished ? 'The agenda is public.' : 'Scheduled sessions are not public yet.',
      [
        { href: `/admin/${slug}/agenda`, label: 'Open the builder' },
        { href: `/${slug}/agenda`, label: 'See it as the public does ↗' },
      ]
    ) +
    doorCard('People', 'Everyone confirmed to speak, and what they still owe you.', [
      { href: `/admin/${slug}/people`, label: 'Open people' },
    ]) +
    doorCard('Green room', 'The day-of sheet for your crew.', [
      { href: `/admin/${slug}/green-room`, label: 'Open green room' },
    ]) +
    doorCard('Slides', 'Which decks are in.', [
      { href: `/admin/${slug}/slides`, label: 'Open slides' },
    ]) +
    doorCard('Settings', 'Team, dates, and the call itself.', [
      { href: `/admin/${slug}/settings`, label: 'Open settings' },
    ]);

  const body =
    '<div style="padding:26px 0 0">' +
    `<h1 class="display">${esc(ev.name)}</h1>` +
    `<p class="sub" style="margin-top:6px">${esc(dateRange(ev.startsOn, ev.endsOn))} · ` +
    `${esc(callStateText(ev))}${ev.tzLabel ? ` · ${esc(ev.tzLabel)}` : ''}</p>` +
    '<p class="serif" style="font-size:19px;color:var(--ink-soft);margin-top:16px;max-width:40em">' +
    'A decision leaves when you send it, not when you make it. Who has been told is never a guess.</p>' +
    '</div>' +
    attnBand(ev, counts) +
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
      if (!ev) return c.html(deniedPage(), 403);
      const { counts } = await pile(c.env.DB, principal, ev.id, 'all', { limit: 0 });
      return c.html(programPage(principal, ev, counts));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(), 403);
      throw e;
    }
  });
}
