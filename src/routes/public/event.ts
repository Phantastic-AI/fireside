// The event home: kicker, name, intro, the fact rail, one loud button, two
// facts about the event, and who is already on the program. Mirrors the
// prototype's screenEvent + factRail + speakerStrip (S-2, ~lines 1450-1494).
//
// Who this page is for, in that order. Dani Okafor walks in with "who is
// speaking, when and where is it, and should I start planning?" — every
// choice below serves that read. Priya Raghunathan, who has a talk in her and
// no idea whether there is still room for it, gets exactly one line and one
// quiet button, in her own verb: submit a talk.
//
// What is deliberately not here: the funnel. How much came in and how much was
// taken is the committee's arithmetic — it is not a fact anybody out here can
// act on, and printed on a landing page it reads as a scoreboard. It stays
// backstage. The counts on `EventCounts` are read by other screens; this one
// asks for none of them.
//
// Gaps routed around — queries/public.ts has no query for these facts, so
// nothing here guesses at them:
//  - No organizer-name query exists. The prototype's fact rail opens with
//    "Organizer: {name}"; ours carries the call's next move, the
//    Program/Speakers links, and the venue.
//  - No track/room breakdown exists on this read, so the second card carries
//    the reader's next move rather than the prototype's "across N tracks and
//    M rooms."

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, onstageShell, eventNav, page } from '../../lib/html';
import { eventBySlug, speakersGallery, type EventHome, type GallerySpeaker } from '../../queries/public';

/* ------------------------------------------------------------------ *
 * Date helpers, local to this screen.
 * ------------------------------------------------------------------ */

/** A day key (`YYYY-MM-DD`) read as its own wall-clock date — no timezone
 *  conversion, because the key is already the event's own local day. */
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

/** An instant as "20 August" in the event's own timezone — day first, the way
 *  the date range above it is written. en-US would order it the other way. */
function dayMonthAt(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${get('month')}`;
}

/** A day key ("2026-08-27") as "27 August", read as its own wall date. */
function dayMonthOn(iso: string): string {
  const p = dayParts(iso);
  return `${p.day} ${p.month}`;
}

/* ------------------------------------------------------------------ *
 * Copy.
 * ------------------------------------------------------------------ */

/**
 * The call, said as the next move rather than as a state. Somebody reading
 * this page is either coming to listen — in which case the call is a passing
 * fact — or thinking about speaking, in which case the only two things worth
 * knowing are whether there is still time and, once there is not, when they
 * hear. An event that has already run says neither: nobody is deciding
 * anything about its call any more.
 */
function callStateText(ev: EventHome): string | null {
  if (ev.lifecycle === 'happened') return null;
  if (ev.lifecycle === 'open') {
    return ev.cfpClosesAt !== null
      ? `You can still submit a talk until ${dayMonthAt(ev.cfpClosesAt, ev.timezone)}`
      : 'You can still submit a talk';
  }
  return ev.decideBy ? `The call is closed — decisions by ${dayMonthOn(ev.decideBy)}` : 'The call is closed';
}

function factRailHtml(ev: EventHome): string {
  const slug = esc(ev.slug);
  const call = callStateText(ev);
  const cells = [
    `<a class="link" href="/${slug}/agenda">Program ↗</a>`,
    `<a class="link" href="/${slug}/speakers">Speakers ↗</a>`,
  ];
  if (call) cells.unshift(esc(call));
  if (ev.venueName) cells.push(esc(ev.venueName));
  const sep = '<span style="opacity:.4">│</span>';
  return (
    '<div class="sub" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;' +
    'margin-top:18px;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)">' +
    cells.map((c) => `<span>${c}</span>`).join(sep) +
    '</div>'
  );
}

function buttonRowHtml(ev: EventHome): string {
  const slug = esc(ev.slug);
  // The loud button belongs to whoever came to listen — the program if there
  // is one, the people if there is not. Somebody thinking of speaking gets the
  // quieter button beside it, in their own verb.
  const primary = ev.agendaPublished
    ? `<a class="btn btn-primary btn-lg" href="/${slug}/agenda">See the agenda →</a>`
    : `<a class="btn btn-primary btn-lg" href="/${slug}/speakers">See who is speaking →</a>`;
  const pitch = ev.lifecycle === 'open' ? `<a class="btn" href="/${slug}/cfp">Submit a talk</a>` : '';
  return `<div class="btnrow" style="margin-top:22px">${primary}${pitch}</div>`;
}

function cardHtml(title: string, inner: string): string {
  return (
    '<div class="card card-pad">' +
    `<h3 class="serif" style="font-size:21px;font-weight:600">${esc(title)}</h3>` +
    `<p class="sub" style="margin-top:6px">${inner}</p>` +
    '</div>'
  );
}

/**
 * The card beside the venue. Never the funnel: how much came in and how much
 * was taken is arithmetic nobody out here can act on, and it reads as a
 * scoreboard on a page somebody opened to find out who is speaking. This one
 * answers what they did come with — is there anything to plan around yet.
 */
function programCardHtml(ev: EventHome): string {
  const slug = esc(ev.slug);
  if (ev.lifecycle === 'happened') {
    return cardHtml(
      'Everything that ran',
      `<a class="link" href="/${slug}/agenda">The whole program is still up</a>, talk by talk, ` +
        'with recordings where there are any.'
    );
  }
  if (ev.agendaPublished) {
    return cardHtml(
      'Start planning your days',
      'Star the talks you want to see and they line up in ' +
        `<a class="link" href="/${slug}/my-schedule">one list</a>, in the order you will walk to them.`
    );
  }
  return cardHtml(
    'The program is still coming together',
    `Speakers already confirmed are on the <a class="link" href="/${slug}/speakers">speakers page</a>.`
  );
}

function venueCardHtml(ev: EventHome): string {
  const title = ev.venueName ?? 'Venue to be announced';
  const tz = ev.tzLabel ?? ev.timezone;
  return cardHtml(title, `${esc(dateRange(ev.startsOn, ev.endsOn))}. ${esc(tz)}.`);
}

/** The no-headshot mark: initials in a dashed circle. No headshot is seeded
 *  for anyone yet, so every avatar on this screen uses this one form. */
function avatarHtml(initials: string): string {
  return (
    '<svg class="av" width="46" height="46" viewBox="0 0 40 40" role="img" aria-label="No headshot yet">' +
    '<circle cx="20" cy="20" r="19.2" fill="none" stroke="#D8CEBE" stroke-width="1.2" stroke-dasharray="3 3"/>' +
    '<text x="20" y="20" text-anchor="middle" dominant-baseline="central" font-family="ui-sans-serif,system-ui,sans-serif" ' +
    `font-size="13" font-weight="600" fill="#B4A996">${esc(initials)}</text></svg>`
  );
}

function speakerStripHtml(ev: EventHome, speakers: GallerySpeaker[]): string {
  const slug = esc(ev.slug);
  const list = speakers.slice(0, 8);
  if (list.length === 0) {
    return (
      '<div class="sec"><h2 class="display" style="font-size:26px;margin-bottom:14px">Nobody is on the program yet</h2>' +
      '<p class="sub">The first names go up here as soon as the program takes shape.</p></div>'
    );
  }
  const cards = list
    .map((p) => {
      const roleLine = [p.jobTitle, p.organisation]
        .filter((v): v is string => !!v)
        .map((v) => esc(v))
        .join('<br>');
      return (
        `<a class="gcard" href="/${slug}/speakers/${esc(p.personId)}">` +
        avatarHtml(p.initials) +
        `<div class="gname">${esc(p.name)}</div>` +
        (roleLine ? `<div class="grole">${roleLine}</div>` : '') +
        '</a>'
      );
    })
    .join('');
  return (
    '<div class="sec"><h2 class="display" style="font-size:26px;margin-bottom:14px">Already on the program</h2>' +
    `<div class="gal">${cards}</div>` +
    `<p style="margin-top:14px"><a class="link" href="/${slug}/speakers">See everyone speaking →</a></p></div>`
  );
}

/* ------------------------------------------------------------------ *
 * The screen.
 * ------------------------------------------------------------------ */

function eventHomePage(ev: EventHome, speakers: GallerySpeaker[]): string {
  const nav = eventNav(ev.slug, '', ev.lifecycle === 'open');
  const main =
    '<div class="wrap">' +
    '<div style="padding:46px 0 0">' +
    `<div class="kicker">${esc(dateRange(ev.startsOn, ev.endsOn))}</div>` +
    `<h1 class="display" style="margin-top:12px">${esc(ev.name)}</h1>` +
    (ev.cfpIntro
      ? `<p class="lede serif" style="margin-top:18px;font-size:19px;line-height:1.6">${esc(ev.cfpIntro)}</p>`
      : '') +
    factRailHtml(ev) +
    buttonRowHtml(ev) +
    '</div>' +
    '<div class="sec grid2">' +
    venueCardHtml(ev) +
    programCardHtml(ev) +
    '</div>' +
    speakerStripHtml(ev, speakers) +
    '</div>';

  return page({
    title: `${ev.name} · Fireside`,
    description: ev.cfpIntro ?? undefined,
    register: 'onstage',
    body: onstageShell(nav, main),
  });
}

/* ------------------------------------------------------------------ *
 * Route.
 * ------------------------------------------------------------------ */

export function registerEventHome(app: Hono<{ Bindings: Env }>): void {
  app.get('/:eventSlug', async (c, next) => {
    const slug = c.req.param('eventSlug');
    const ev = await eventBySlug(c.env.DB, slug);
    if (!ev) return next();
    const speakers = await speakersGallery(c.env.DB, ev.id);
    return c.html(eventHomePage(ev, speakers));
  });
}
