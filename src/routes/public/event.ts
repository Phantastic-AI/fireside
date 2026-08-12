// The event home: kicker, name, intro, the fact rail, the call to action,
// two facts about the event, and who is already on the program. Mirrors the
// prototype's screenEvent + factRail + speakerStrip (S-2, ~lines 1450-1494).
//
// Personas: Priya Raghunathan (speaker) walks in asking "where do things
// stand with my talk?" — this is her front door before her portal exists to
// her. Dani Okafor (attendee) walks in asking "what's worth arriving early
// for?" and gets that from the intro, the program link, and the people
// already announced, with zero ceremony before any of it.
//
// Gaps routed around — queries/public.ts has no query for these facts, so
// nothing here guesses at them:
//  - No organizer-name query exists. The prototype's fact rail opens with
//    "Organizer: {name}"; ours carries only the call's state, the
//    Program/Speakers links, and the venue.
//  - `EventCounts` has no track/room breakdown, so the first fact card reads
//    "{n} accepted so far · {n} speaking" instead of the prototype's
//    "across N tracks and M rooms."
//  - `Lifecycle` has only 'open' | 'closed' | 'happened', and labels.ts
//    documents `call.happened` as a fact with no §6 row at all. A past
//    event's call did close (at cfp_closes_at), so `call.closed` stays
//    literally true there and is what the fact rail uses for it — no new
//    copy invented.
//
// Scope trim: the prototype's hint line under the button row (decide-by
// date, submission cap) restates the fact rail's call-state sentence with
// two more numbers; left out rather than duplicating the fact rail with
// slightly different words.

import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, onstageShell, eventNav, page } from '../../lib/html';
import { label } from '../../lib/labels';
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

/** An instant, read as a day-and-month in the event's own timezone. */
function dayMonthAt(ms: number, timezone: string): string {
  return new Date(ms).toLocaleDateString('en-US', { timeZone: timezone, day: 'numeric', month: 'long' });
}

/* ------------------------------------------------------------------ *
 * Copy.
 * ------------------------------------------------------------------ */

/** The call's own state, in the fact rail's words (labels.ts, §1.7). */
function callStateText(ev: EventHome): string {
  if (ev.lifecycle === 'open' && ev.cfpClosesAt !== null) {
    return label('call.open', 'onstage').replace('{date}', dayMonthAt(ev.cfpClosesAt, ev.timezone));
  }
  if (ev.cfpClosesAt !== null) {
    return label('call.closed', 'onstage').replace('{date}', dayMonthAt(ev.cfpClosesAt, ev.timezone));
  }
  // No closing date on record at all (an event with no call of its own) —
  // the same sentence, minus the date clause rather than a guessed one.
  return label('call.closed', 'onstage').replace(' on {date}', '');
}

function factRailHtml(ev: EventHome): string {
  const slug = esc(ev.slug);
  const cells = [
    esc(callStateText(ev)),
    `<a class="link" href="/${slug}/agenda">Program ↗</a>`,
    `<a class="link" href="/${slug}/speakers">Speakers ↗</a>`,
  ];
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
  const primary =
    ev.lifecycle === 'open'
      ? `<a class="btn btn-primary btn-lg" href="/${slug}/cfp">Open the call</a>`
      : `<a class="btn btn-primary btn-lg" href="/${slug}/agenda">See the program →</a>`;
  const agendaLabel = ev.agendaPublished ? 'See the agenda' : 'See who is speaking';
  return (
    `<div class="btnrow" style="margin-top:22px">${primary}` +
    `<a class="btn" href="/${slug}/agenda">${agendaLabel}</a>` +
    `<a class="btn" href="/${slug}/portal">Your speaker portal</a></div>`
  );
}

function proposalsCardHtml(ev: EventHome): string {
  const { proposals, accepted, speakers } = ev.counts;
  const slug = esc(ev.slug);
  if (proposals > 0) {
    const noun = proposals === 1 ? 'proposal' : 'proposals';
    const speakerNote = speakers > 0 ? ` · ${esc(speakers)} speaking` : '';
    return (
      '<div class="card card-pad">' +
      `<h3 class="serif" style="font-size:21px;font-weight:600">${esc(proposals)} ${noun} came in</h3>` +
      `<p class="sub" style="margin-top:6px">${esc(accepted)} accepted so far${speakerNote}.</p>` +
      '</div>'
    );
  }
  // Never a bare zero: name the next thing and link to it.
  if (ev.lifecycle === 'open') {
    return (
      '<div class="card card-pad">' +
      '<h3 class="serif" style="font-size:21px;font-weight:600">Be the first to send one in</h3>' +
      `<p class="sub" style="margin-top:6px"><a class="link" href="/${slug}/cfp">Open the call</a> and start a proposal.</p>` +
      '</div>'
    );
  }
  return (
    '<div class="card card-pad">' +
    '<h3 class="serif" style="font-size:21px;font-weight:600">The program is still coming together</h3>' +
    `<p class="sub" style="margin-top:6px"><a class="link" href="/${slug}/agenda">See the program</a> once it is published.</p>` +
    '</div>'
  );
}

function venueCardHtml(ev: EventHome): string {
  const title = ev.venueName ?? 'Venue to be announced';
  const tz = ev.tzLabel ?? ev.timezone;
  return (
    '<div class="card card-pad">' +
    `<h3 class="serif" style="font-size:21px;font-weight:600">${esc(title)}</h3>` +
    `<p class="sub" style="margin-top:6px">${esc(dateRange(ev.startsOn, ev.endsOn))}. ${esc(tz)}.</p>` +
    '</div>'
  );
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
    const cta =
      ev.lifecycle === 'open'
        ? `<a class="link" href="/${slug}/cfp">Open the call</a>`
        : `<a class="link" href="/${slug}/speakers">See the speakers page</a>`;
    return (
      '<div class="sec"><h2 class="display" style="font-size:26px;margin-bottom:14px">Nobody is on the program yet</h2>' +
      `<p class="sub">${cta} to see what comes next.</p></div>`
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
    proposalsCardHtml(ev) +
    venueCardHtml(ev) +
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
