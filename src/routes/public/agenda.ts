// The public agenda and the session page — S-6 and S-7. Dani Okafor's two
// screens: "what's worth arriving early for?" before the event, "which room,
// right now?" on one bar of venue wifi during it. No account, no spinner,
// mirrors the prototype's screenAgenda / screenSession markup exactly so the
// lifted CSS in src/styles/ styles it without extra rules.
//
// Register law: onstage, warm, second person, dates not statuses (D-025,
// D-027). State words go through lib/labels.ts; every dynamic string through
// esc(). No SQL here — reads go through queries/public.ts only.
//
// What a visitor can do here, and what each costs:
//  - Search (?q=) and narrow by day, track, format and room. All five compose,
//    all five survive in every chip href, and all five are applied in this file
//    over the DTO the agenda query already returned — no second read, no SQL.
//  - Star a session. Signed out that is localStorage under the same key
//    src/islands/stars.js reads ('fireside.stars.' + slug), painted by the
//    island below; with scripts off the star is a plain link to my schedule,
//    which is where the promise is kept either way. Signed in it is a real
//    form posting to /:event/my-schedule/star — one click, private, undone by
//    the same click on the next screen (D-024).
//  - Embedded (?embed=1) there are no star controls at all: an iframe on
//    somebody else's page is a window onto the program, not a place to keep
//    things. It gets one quiet way back to the event's own site instead (R-6).
//
// Scope notes (see report to the calling agent for the full list):
//  - AgendaSession carries no abstract, so the one-line description snippet
//    EMB-09 asks for cannot be rendered on a row. The session page has the
//    whole abstract and shows it. Flagged rather than faked.
//  - Speaker job titles and organisations come from speakersGallery(), the
//    public query the speakers page already uses — one more read on this
//    screen, run alongside the agenda read, and no new SQL anywhere.
//  - The session page drops the prototype's "Also on this program" rail —
//    it needs a query this parcel's task did not name.
import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, onstageShell, eventNav } from '../../lib/html';
import { label, FORMAT_KEY, type LabelKey } from '../../lib/labels';
import {
  agenda,
  eventBySlug,
  sessionBySlug,
  speakersGallery,
  type Agenda,
  type AgendaSession,
  type EventHome,
  type PublicSpeaker,
  type SpeakerRef,
} from '../../queries/public';
import { socialView } from '../../queries/social';
import { principalFromCookie } from '../../workflows/account';

// The star island's source, inlined into the page (the cfp.js convention —
// it exports its own text). One fewer request on the screen most likely to be
// opened on one bar of signal.
import agendaStarsIsland from '../../islands/agenda-stars.js';

/* ------------------------------------------------------------------ *
 * Formatting helpers. No shared lib.ts owns date/time formatting yet,
 * so these are local and small on purpose — see report.
 * ------------------------------------------------------------------ */

function dateFromKey(iso: string): Date {
  const parts = iso.split('-');
  const y = Number(parts[0] ?? '1970');
  const m = Number(parts[1] ?? '1');
  const d = Number(parts[2] ?? '1');
  return new Date(Date.UTC(y, m - 1, d));
}

/** A day key ("2026-09-03") to "Thu 3 Sep" / "Thursday 3 Sep". The key is
 *  already a wall date (queries/public.ts's eventDayKey), so this formats it
 *  in UTC rather than re-applying the event timezone and risking a shift. */
function weekdayDate(iso: string, weekday: 'short' | 'long'): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday,
    day: 'numeric',
    month: 'short',
  }).format(dateFromKey(iso));
}

/** A day key as "27 August" — day first, the way every other date on this
 *  screen is written. en-US would order it the other way round on its own. */
function dateLabel(iso: string): string {
  const d = dateFromKey(iso);
  const month = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' }).format(d);
  return `${d.getUTCDate()} ${month}`;
}

/** An instant as "20 August", read in the event's own timezone — a call that
 *  closes at 23:59 in New York closed on the New York day, not the UTC one. */
function dayMonth(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')} ${get('month')}`;
}

function dateRangeLabel(startsOn: string, endsOn: string): string {
  if (startsOn === endsOn) return dateLabel(startsOn);
  const s = dateFromKey(startsOn);
  const e = dateFromKey(endsOn);
  const monthOf = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' }).format(d);
  if (s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear()) {
    return `${s.getUTCDate()}–${e.getUTCDate()} ${monthOf(s)}`;
  }
  return `${s.getUTCDate()} ${monthOf(s)} – ${e.getUTCDate()} ${monthOf(e)}`;
}

/** Epoch ms to "HH:MM" in the event's own timezone — a conference clock, not UTC. */
function timeOfDay(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

/** EMB-08 — "15:00–15:30". A time on its own answers "when"; a range answers
 *  "can I make the next one", which is the question a program is read with. */
function timeRange(startsAt: number, minutes: number, timezone: string): string {
  return `${timeOfDay(startsAt, timezone)}–${timeOfDay(startsAt + minutes * 60_000, timezone)}`;
}

function durationLabel(minutes: number): string {
  return minutes >= 90 && minutes % 60 === 0 ? `${minutes / 60} hr` : `${minutes} min`;
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${num(n)} ${many}`;
}

/** The timezone line. tz_label is written by the organizer and often already
 *  says it ("All times ET"), so this adds the words only when they are missing
 *  rather than printing "All times All times ET" at the top of the program. */
function timesLine(tzLabel: string | null): string | null {
  if (!tzLabel) return null;
  return /^all times\b/i.test(tzLabel) ? tzLabel : `All times ${tzLabel}`;
}

function joinParts(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(' · ');
}

/**
 * The line under the dates: how much there is to choose from, whether more is
 * still coming, and what a star is worth. Three seasons, because a program
 * still filling up, a program having its last talks settled, and a program
 * that already ran are three different reads — and only the first two are
 * worth planning a walk around.
 */
function programLine(event: EventHome, total: number): string {
  const sessions = plural(total, 'session', 'sessions');
  if (event.lifecycle === 'happened') {
    return (
      `${sessions}, exactly as ${total === 1 ? 'it' : 'they'} ran. ` +
      'Star the ones you want to watch back; your list keeps them in one place.'
    );
  }
  const coming =
    event.lifecycle === 'open' && event.cfpClosesAt !== null
      ? `more landing until ${dayMonth(event.cfpClosesAt, event.timezone)}`
      : 'more still landing';
  return (
    `${sessions} to choose from — ${coming}. ` +
    'Star what pulls at you; your list keeps up as the schedule grows.'
  );
}

/** "A", "A with B", "A with B and C", "A with B, C and D" — the prototype's byline(). */
function byline(names: string[]): string {
  const n = names.map((x) => esc(x));
  const a = n[0] ?? '';
  if (n.length <= 1) return a;
  if (n.length === 2) return `${a} with ${n[1]}`;
  const middle = n.slice(1, -1).join(', ');
  return `${a} with ${middle} and ${n[n.length - 1]}`;
}

/* ------------------------------------------------------------------ *
 * Formats and tracks: the enum words, through label(); the colours,
 * through the DB's own single `colour` column (no stored wash — see
 * report — so the wash is computed with color-mix() at render time).
 * ------------------------------------------------------------------ */

// FORMAT_KEY in lib/labels.ts maps the stored casing ('Talk', 'Lightning
// talk'). The lowercase spellings below are the same four facts written the
// way older rows and hand-typed addresses spell them, so one word never
// reaches a reader unlabelled.
const LOOSE_FORMAT_KEY: Record<string, LabelKey> = {
  talk: 'format.talk',
  workshop: 'format.workshop',
  panel: 'format.panel',
  lightning: 'format.lightning',
  'lightning talk': 'format.lightning',
};

function formatLabel(fmt: string): string {
  const key = FORMAT_KEY[fmt] ?? LOOSE_FORMAT_KEY[fmt.toLowerCase()];
  return key ? label(key, 'onstage') : fmt;
}

/** The format as it travels in an address: "lightning-talk", never "Lightning talk". */
function formatSlug(fmt: string): string {
  return fmt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function trackStyle(colour: string): string {
  const c = esc(colour);
  return `--tc:${c};--tw:color-mix(in srgb, ${c} 16%, white)`;
}

function trackBadge(track: { name: string; colour: string } | null): string {
  if (!track) return '';
  return `<span class="tk" style="${trackStyle(track.colour)}">${esc(track.name)}</span>`;
}

/* ------------------------------------------------------------------ *
 * Who the speakers are, beyond their names. AgendaSession's SpeakerRef
 * carries a name and nothing else, so the one job title and employer a
 * program is actually read for come from speakersGallery() — the same
 * public query the speakers page runs, keyed by person.
 * ------------------------------------------------------------------ */

type Role = { jobTitle: string | null; organisation: string | null; headshotFileId: string | null };
type RoleIndex = Map<string, Role>;

function roleWords(r: Role | undefined): string {
  if (!r) return '';
  return [r.jobTitle, r.organisation].filter((x): x is string => !!x).join(' at ');
}

/** One line under the byline: what the one speaker does, or — when a session
 *  has several — the places they have come from, each named once. */
function roleLine(speakers: SpeakerRef[], roles: RoleIndex): string {
  const first = speakers[0];
  if (speakers.length === 1 && first) return roleWords(roles.get(first.personId));
  const orgs: string[] = [];
  for (const p of speakers) {
    const org = roles.get(p.personId)?.organisation;
    if (org && !orgs.includes(org)) orgs.push(org);
  }
  return orgs.join(' · ');
}

/* ------------------------------------------------------------------ *
 * Searching. Case-folded, over exactly what the card in front of you
 * says: title, who is speaking, where they work, track, format. Every
 * word typed has to appear somewhere, so "priya latency" narrows rather
 * than widens. Done here, over the DTO — the agenda read already has
 * every session in hand, and a second query would be a slower way to
 * learn nothing new.
 * ------------------------------------------------------------------ */

const SEARCH_MAX = 80;

function tokensOf(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

function haystack(s: AgendaSession, roles: RoleIndex): string {
  const people = s.speakers.map((p) => `${p.name} ${roleWords(roles.get(p.personId))}`).join(' ');
  return `${s.title} ${people} ${s.track?.name ?? ''} ${s.roomName ?? ''} ${formatLabel(s.format)} ${s.format}`.toLowerCase();
}

/** The room as it travels in an address: "ballroom-a", never "Ballroom A". */
function roomSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/* ------------------------------------------------------------------ *
 * Avatars: the speaker's own photograph where there is one (/files/ is
 * the image door), and otherwise a generated, deterministic mark — no
 * network request, the same promise the prototype makes.
 * ------------------------------------------------------------------ */

const AV_PALETTE: [string, string][] = [
  ['#F3DDC6', '#8A4E1C'],
  ['#DDE8E4', '#1F5B4E'],
  ['#EEDCE4', '#7B3352'],
  ['#E3E1EF', '#3F3A72'],
  ['#EFE6C9', '#6B5A15'],
  ['#E0EAEF', '#1E5468'],
  ['#F0DFD8', '#8C3B2B'],
  ['#DFE9D6', '#3E5C26'],
];

function hashOf(s: string): number {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return x;
}

function paletteFor(name: string): [string, string] {
  return AV_PALETTE[hashOf(name) % AV_PALETTE.length] ?? ['#EFE6C9', '#6B5A15'];
}

function avatarSvg(name: string, initials: string, size: number, hasPhoto: boolean): string {
  if (!hasPhoto) {
    return (
      `<svg class="av" width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="No headshot yet">` +
      '<circle cx="20" cy="20" r="19.2" fill="none" stroke="#D8CEBE" stroke-width="1.2" stroke-dasharray="3 3"/>' +
      `<text x="20" y="20" text-anchor="middle" dominant-baseline="central" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13" font-weight="600" fill="#B4A996">${esc(initials)}</text></svg>`
    );
  }
  const [wash, ink] = paletteFor(name);
  return (
    `<svg class="av" width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="${esc(name)}">` +
    `<circle cx="20" cy="20" r="20" fill="${esc(wash)}"/>` +
    `<text x="20" y="21" text-anchor="middle" dominant-baseline="central" font-family="Iowan Old Style,Palatino,Georgia,serif" font-size="15" font-weight="600" fill="${esc(ink)}">${esc(initials)}</text>` +
    `<circle cx="20" cy="20" r="19.4" fill="none" stroke="rgba(34,30,23,.12)" stroke-width="1.2"/></svg>`
  );
}

/** The face itself when there is one — decorative, because the name is
 *  written beside it and a screen reader should hear it once, not twice. */
function faceOf(p: { name: string; initials: string; headshotFileId: string | null }, size: number): string {
  if (!p.headshotFileId) return avatarSvg(p.name, p.initials, size, false);
  return (
    `<img class="av" src="/files/${esc(p.headshotFileId)}" alt="" width="${size}" height="${size}" ` +
    `loading="lazy" decoding="async" style="width:${size}px;height:${size}px;object-fit:cover">`
  );
}

/* ------------------------------------------------------------------ *
 * URL building — search, day, track, format and embed state, preserved
 * across every chip and every form on the screen.
 * ------------------------------------------------------------------ */

function withQuery(path: string, params: Record<string, string | null>): string {
  const u = new URL(path, 'https://x.invalid');
  for (const [k, v] of Object.entries(params)) {
    if (v) u.searchParams.set(k, v);
    else u.searchParams.delete(k);
  }
  const qs = u.searchParams.toString();
  return qs ? `${u.pathname}?${qs}` : u.pathname;
}

type Filters = { q: string; day: string; track: string; format: string; room: string; embed: boolean };

/**
 * Where a link goes from here. On the event's own site, next door. From inside
 * somebody else's page, out to the event's own site in a new tab: an embedded
 * program that swallows a partner's page whole, or that opens a full site
 * inside a 600-pixel frame, is a bad guest either way.
 */
type Outbound = { href: (path: string) => string; attrs: string };
const NEXT_DOOR: Outbound = { href: (p) => p, attrs: '' };
function outOfFrame(origin: string): Outbound {
  return { href: (p) => `${origin}${p}`, attrs: ' target="_blank" rel="noopener"' };
}

/* ------------------------------------------------------------------ *
 * The star. Three shapes of the same act, and which one a row gets is
 * decided once, in the route.
 * ------------------------------------------------------------------ */

const STAR_PATH =
  '<path d="M12 3.2l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.7l6.1-.9z"/>';

function starSvg(on: boolean): string {
  return (
    `<svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true" fill="${on ? 'currentColor' : 'none'}" ` +
    `stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${STAR_PATH}</svg>`
  );
}

type Stars =
  /** Embedded: somebody else's page, so nothing to keep here (R-6). */
  | { kind: 'none' }
  /** Signed out: this browser's own list, painted by islands/agenda-stars.js. */
  | { kind: 'local' }
  /** Signed in: a real write, and the same click takes it off again. */
  | { kind: 'account'; starred: Set<string> };

/* ------------------------------------------------------------------ *
 * Session card — mirrors the prototype's seshCard.
 * ------------------------------------------------------------------ */

function seshCard(
  slug: string,
  timezone: string,
  s: AgendaSession,
  roles: RoleIndex,
  stars: Stars,
  link: Outbound
): string {
  const href = s.publicSlug ? esc(link.href(`/${slug}/s/${s.publicSlug}`)) : null;
  const strike = s.cancelled ? ' style="text-decoration:line-through;text-decoration-color:var(--muted-2)"' : '';
  const titleHtml = href
    ? `<a href="${href}"${link.attrs}${strike}>${esc(s.title)}</a>`
    : `<span${strike}>${esc(s.title)}</span>`;
  const names = s.speakers.map((p) => p.name);
  const role = roleLine(s.speakers, roles);

  const card =
    `<article class="sesh" style="${s.track ? trackStyle(s.track.colour) : ''}">` +
    '<div class="sesh-main">' +
    `<div class="sesh-when"><span class="time">${esc(timeRange(s.startsAt, s.minutes, timezone))}</span>` +
    (s.roomName ? `<span class="room">${esc(s.roomName)}</span>` : '') +
    '</div>' +
    `<h3>${titleHtml}</h3>` +
    (names.length ? `<div class="sesh-by"><span>${byline(names)}</span></div>` : '') +
    (role ? `<div class="sub" style="margin-top:3px">${esc(role)}</div>` : '') +
    `<div class="sesh-meta">${trackBadge(s.track)}<span>${esc(formatLabel(s.format))} · ${esc(durationLabel(s.minutes))}</span>` +
    (s.cancelled ? `<span class="sub">· ${esc(label('submission.cancelled', 'onstage'))}</span>` : '') +
    '</div></div>';

  // A cancelled talk stays on the program, struck through — but it is not
  // something anyone should be invited to plan around.
  if (stars.kind === 'none' || s.cancelled) return `${card}</article>`;

  if (stars.kind === 'local') {
    // Scripts off, this is a link to the page that explains the whole idea.
    // Scripts on, islands/agenda-stars.js takes the click and keeps the id
    // in this browser under the key my schedule already reads.
    return (
      card +
      `<a class="starbtn" href="/${esc(slug)}/my-schedule" data-star="${esc(s.id)}" ` +
      `aria-label="Star this session">${starSvg(false)}</a></article>`
    );
  }

  const on = stars.starred.has(s.id);
  // The form wraps the card rather than sitting inside it: .slot is a column
  // flex box, so a form is a perfectly good flex item and the card inside it
  // lays out exactly as it does everywhere else (schedule.ts does the same).
  return (
    `<form method="post" action="/${esc(slug)}/my-schedule/star">` +
    card +
    `<input type="hidden" name="session" value="${esc(s.id)}">` +
    `<input type="hidden" name="on" value="${on ? '0' : '1'}">` +
    `<button class="starbtn" type="submit" aria-pressed="${on}" ` +
    `aria-label="${on ? 'Take this off my schedule' : 'Star this session'}">${starSvg(on)}</button>` +
    '</article></form>'
  );
}

/* ------------------------------------------------------------------ *
 * The published agenda body: header, search, day / track / format / room
 * chips, the day-by-day list. Room lanes read as consecutive same-time
 * cards, each naming its own room — the prototype never used a literal
 * multi-column grid either.
 * ------------------------------------------------------------------ */

function agendaBody(
  event: EventHome,
  ag: Agenda,
  f: Filters,
  slug: string,
  roles: RoleIndex,
  stars: Stars,
  link: Outbound
): string {
  const allSessions = ag.days.flatMap((d) => d.slots.flatMap((sl) => sl.sessions));

  const trackList: { slug: string; name: string; colour: string }[] = [];
  const seenTracks = new Set<string>();
  const formatList: { slug: string; name: string }[] = [];
  const seenFormats = new Set<string>();
  for (const s of allSessions) {
    if (s.track && !seenTracks.has(s.track.slug)) {
      seenTracks.add(s.track.slug);
      trackList.push(s.track);
    }
    const fslug = formatSlug(s.format);
    if (fslug && !seenFormats.has(fslug)) {
      seenFormats.add(fslug);
      formatList.push({ slug: fslug, name: formatLabel(s.format) });
    }
  }
  const roomNames = new Set(allSessions.map((s) => s.roomName).filter((x): x is string => !!x));

  const base = `/${slug}/agenda`;
  const hereUrl = (over: { q?: string | null; day?: string | null; track?: string | null; format?: string | null; room?: string | null }) =>
    withQuery(base, {
      q: over.q !== undefined ? over.q : f.q || null,
      day: over.day !== undefined ? over.day : f.day || null,
      track: over.track !== undefined ? over.track : f.track || null,
      format: over.format !== undefined ? over.format : f.format || null,
      room: over.room !== undefined ? over.room : f.room || null,
      embed: f.embed ? '1' : null,
    });

  const chip = (href: string, on: boolean, text: string, extra = '') =>
    `<a class="fchip${extra ? ` ${extra}` : ''}" href="${esc(href)}" aria-pressed="${on}">${text}</a>`;

  const dayChips =
    chip(hereUrl({ day: null }), !f.day, 'All days') +
    ag.days.map((d) => chip(hereUrl({ day: d.day }), f.day === d.day, esc(weekdayDate(d.day, 'short')))).join('');

  const trackChips = trackList.length
    ? chip(hereUrl({ track: null }), !f.track, 'All tracks') +
      trackList
        .map(
          (t) =>
            `<a class="fchip tkchip" style="${trackStyle(t.colour)}" href="${esc(hereUrl({ track: t.slug }))}" aria-pressed="${f.track === t.slug}">${esc(t.name)}</a>`
        )
        .join('')
    : '';

  const formatChips =
    formatList.length > 1
      ? chip(hereUrl({ format: null }), !f.format, 'Every kind') +
        formatList.map((x) => chip(hereUrl({ format: x.slug }), f.format === x.slug, esc(x.name))).join('')
      : '';

  // Rooms narrow too — the person running Ballroom A all day reads the agenda
  // by room, not by track, and so does anyone deciding whether to move seats.
  const roomList = [...roomNames].sort();
  const roomChips =
    roomList.length > 1
      ? chip(hereUrl({ room: null }), !f.room, 'All rooms') +
        roomList.map((r) => chip(hereUrl({ room: roomSlug(r) }), f.room === roomSlug(r), esc(r))).join('')
      : '';

  // The search box carries whatever is already narrowed, so typing a word
  // never quietly throws away the day somebody had picked.
  const hidden = (name: string, value: string) =>
    value ? `<input type="hidden" name="${name}" value="${esc(value)}">` : '';
  const searchForm =
    `<form method="get" action="${esc(base)}" class="filters" style="margin:18px 0 4px">` +
    hidden('day', f.day) +
    hidden('track', f.track) +
    hidden('format', f.format) +
    hidden('room', f.room) +
    (f.embed ? '<input type="hidden" name="embed" value="1">' : '') +
    `<input type="text" name="q" value="${esc(f.q)}" maxlength="${SEARCH_MAX}" autocomplete="off" ` +
    'placeholder="Search talks and speakers" aria-label="Search talks and speakers" ' +
    'style="flex:1 1 200px;max-width:min(100%,340px)">' +
    '<button class="btn btn-sm" type="submit">Search</button>' +
    (f.q ? `<a class="link" href="${esc(hereUrl({ q: null }))}">Clear the search</a>` : '') +
    '</form>';

  const tokens = tokensOf(f.q);
  const keep = (s: AgendaSession, day: string): boolean => {
    if (f.day && f.day !== day) return false;
    if (f.track && s.track?.slug !== f.track) return false;
    if (f.format && formatSlug(s.format) !== f.format) return false;
    if (f.room && (!s.roomName || roomSlug(s.roomName) !== f.room)) return false;
    if (tokens.length) {
      const hay = haystack(s, roles);
      if (!tokens.every((t) => hay.includes(t))) return false;
    }
    return true;
  };

  let listHtml = '';
  let shown = 0;
  for (const d of ag.days) {
    const inDay = d.slots.flatMap((sl) => sl.sessions).filter((s) => keep(s, d.day));
    if (!inDay.length) continue;
    shown += inDay.length;
    listHtml +=
      `<h2 class="dayhead">${esc(weekdayDate(d.day, 'short'))} · ${esc(plural(inDay.length, 'session', 'sessions'))}</h2>` +
      `<div class="slot">${inDay.map((s) => seshCard(slug, ag.timezone, s, roles, stars, link)).join('')}</div>`;
  }

  const narrowed = Boolean(f.q || f.day || f.track || f.format || f.room);

  if (!allSessions.length) {
    listHtml =
      '<div class="state-out" style="margin-top:26px"><h2>Nothing on the agenda yet.</h2>' +
      '<p>Speakers already confirmed are on the speakers page.</p>' +
      `<a class="btn btn-primary" href="/${esc(slug)}/speakers">See who is speaking →</a></div>`;
  } else if (!shown && f.q) {
    listHtml =
      '<div class="state-out" style="margin-top:26px"><h2>Nothing matches that — clear the search.</h2>' +
      '<p>The search reads titles, speakers, rooms, tracks and the kind of session.</p>' +
      `<a class="btn btn-primary" href="${esc(hereUrl({ q: null }))}">Clear the search →</a></div>`;
  } else if (!shown) {
    listHtml =
      '<div class="state-out" style="margin-top:26px"><h2>Nothing matches those choices.</h2>' +
      '<p>The other days and tracks still have plenty.</p>' +
      `<a class="btn btn-primary" href="${esc(hereUrl({ q: null, day: null, track: null, format: null, room: null }))}">Show the whole agenda →</a></div>`;
  }

  const headLine = joinParts([
    dateRangeLabel(event.startsOn, event.endsOn),
    event.venueName,
    timesLine(event.tzLabel),
  ]);
  // One line, not an inventory: the room count is on every card already, and
  // the speakers page is where people are counted.
  const mastheadLine = programLine(event, allSessions.length);

  // Once anything is narrowed, the honest headline is the arithmetic: how
  // much of the program is in front of you, out of how much there is.
  const resultLine =
    narrowed && allSessions.length
      ? `<p class="sub" style="margin:10px 0 0">${esc(`${num(shown)} of ${plural(allSessions.length, 'session', 'sessions')}.`)}</p>`
      : '';

  // A plain link — no JS, no download button — to the whole agenda as a
  // calendar file (registerIcs, src/routes/public/ics.ts). Only worth
  // offering once there's something in it.
  const icsLink = allSessions.length
    ? `<p class="sub" style="margin-top:6px"><a class="link" href="/${esc(slug)}/agenda.ics">Add to calendar →</a></p>`
    : '';

  const chipRow = (inner: string) => (inner ? `<div class="filters scrollx daybar">${inner}</div>` : '');

  // The one line for the other reader on this page: somebody scrolling a
  // program and thinking they have a talk in them too.
  const pitchLine =
    event.lifecycle === 'open' && allSessions.length
      ? '<p class="sub" style="margin-top:6px">Still time to pitch one of these yourself — ' +
        `<a class="link" href="/${esc(slug)}/cfp">submit a talk</a>.</p>`
      : '';

  const head =
    `<h1 class="display">${esc(event.name)}</h1>` +
    `<p class="sub" style="margin-top:8px">${esc(headLine)}</p>` +
    (allSessions.length ? `<p class="sub">${esc(mastheadLine)}</p>` : '') +
    icsLink +
    pitchLine +
    (allSessions.length ? searchForm : '') +
    chipRow(dayChips) +
    chipRow(trackChips) +
    chipRow(formatChips) +
    chipRow(roomChips) +
    resultLine;

  // Embed mirrors the prototype: day tabs are dropped, because an embedded
  // widget is already scoped by whatever page it sits on. The search and the
  // track and format chips stay — a program somebody else is hosting is still
  // a program you have to find your talk in. R-6: the one way out is a plain
  // link back to the event's own site, opened out of the frame.
  const embedBar =
    (allSessions.length ? searchForm : '') +
    chipRow(trackChips) +
    chipRow(formatChips) +
    chipRow(roomChips) +
    resultLine +
    (allSessions.length
      ? '<p class="sub" style="margin-top:6px">' +
        `<a class="link" href="${esc(link.href(`/${slug}/agenda.ics`))}">Add to calendar →</a> · ` +
        `<a class="link" href="${esc(link.href(`/${slug}/my-schedule`))}"${link.attrs}>Plan your day →</a></p>`
      : '');

  // Signed out, the count comes from the browser and the island writes it in;
  // signed in, the server already knows it. Either way the bar is the way out
  // of the program and into the plan.
  const startedWith = stars.kind === 'account' ? stars.starred.size : 0;
  const starBar =
    stars.kind === 'none' || !allSessions.length
      ? ''
      : '<div class="starcount">' +
        `<span data-starcount>${esc(
          startedWith ? plural(startedWith, 'session starred', 'sessions starred') : 'Nothing starred yet.'
        )}</span>` +
        `<a class="link" style="margin-left:auto" href="/${esc(slug)}/my-schedule">My schedule →</a></div>`;

  // data-stars is the island's whole handshake: the event slug it keys the
  // browser's list by. It is written only when the island is coming.
  return (
    `<div class="wrap"${stars.kind === 'local' ? ` data-stars="${esc(slug)}"` : ''} style="padding-top:${f.embed ? '8px' : '44px'}">` +
    (f.embed ? embedBar : head) +
    listHtml +
    starBar +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * One speaker, on the session page: face, name, title/org, bio.
 * ------------------------------------------------------------------ */

function speakerBlock(slug: string, p: PublicSpeaker): string {
  const titleOrg = joinParts([p.jobTitle, p.organisation]);
  const href = `/${esc(slug)}/speakers/${esc(p.personId)}`;
  return (
    '<div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-bottom:20px">' +
    `<a href="${href}" tabindex="-1" aria-hidden="true">${faceOf(p, 56)}</a>` +
    '<div style="flex:1;min-width:min(100%,240px)">' +
    `<h3 style="margin:0;font-family:var(--serif);font-size:19px;font-weight:600">` +
    `<a href="${href}" style="text-decoration:none;color:inherit">${esc(p.name)}</a></h3>` +
    (titleOrg ? `<p class="sub" style="margin-top:2px">${esc(titleOrg)}</p>` : '') +
    (p.bio ? `<p class="serif" style="margin-top:10px;font-size:16.5px;line-height:1.6;max-width:44em">${esc(p.bio)}</p>` : '') +
    '</div></div>'
  );
}

/* ------------------------------------------------------------------ *
 * Routes.
 * ------------------------------------------------------------------ */

export function registerAgenda(app: Hono<{ Bindings: Env }>): void {
  app.get('/:event/agenda', async (c) => {
    const slug = c.req.param('event');
    const db = c.env.DB;
    const event = await eventBySlug(db, slug);
    if (!event) return c.notFound();

    const embed = c.req.query('embed') === '1';
    // An embedded program is a stranger's window: no cookie is read, so an
    // iframe on somebody's blog can be cached and can never be personal.
    const principal = embed
      ? null
      : await principalFromCookie(db, c.env.SESSION_SECRET, c.req.header('cookie'));

    const [ag, gallery, mine] = await Promise.all([
      agenda(db, event.id),
      speakersGallery(db, event.id),
      principal ? socialView(db, event.id, principal.personId) : Promise.resolve(null),
    ]);
    if (!ag) return c.notFound();

    const roles: RoleIndex = new Map(
      gallery.map((p) => [
        p.personId,
        { jobTitle: p.jobTitle, organisation: p.organisation, headshotFileId: p.headshotFileId },
      ])
    );

    const stars: Stars = embed
      ? { kind: 'none' }
      : mine
        ? { kind: 'account', starred: new Set(mine.mine.starred) }
        : { kind: 'local' };

    const f: Filters = {
      q: (c.req.query('q') || '').slice(0, SEARCH_MAX),
      day: c.req.query('day') || '',
      track: c.req.query('track') || '',
      format: c.req.query('format') || '',
      room: c.req.query('room') || '',
      embed,
    };
    const nav = eventNav(slug, '/agenda', event.lifecycle === 'open');
    const link = embed ? outOfFrame(new URL(c.req.url).origin) : NEXT_DOOR;

    let inner: string;
    if (!ag.published) {
      // Two seasons, one screen: while the call is still open there is nothing
      // to decide yet, and saying otherwise would be the wrong kind of quiet.
      const open = event.lifecycle === 'open';
      const heading = open ? 'The program is still coming together.' : 'The times are not out yet.';
      const clause = open
        ? event.cfpClosesAt !== null
          ? `Talks are still coming in until ${dayMonth(event.cfpClosesAt, event.timezone)}.`
          : 'Talks are still coming in.'
        : event.decideBy
          ? `The lineup is settled by ${dateLabel(event.decideBy)}.`
          : 'Every talk gets a time and a room before the first morning.';
      const headLine = joinParts([
        dateRangeLabel(event.startsOn, event.endsOn),
        event.venueName,
        timesLine(event.tzLabel),
      ]);
      inner =
        `<div class="wrap" style="padding-top:${embed ? '8px' : '44px'}">` +
        (embed
          ? ''
          : `<h1 class="display">${esc(event.name)}</h1>` +
            `<p class="sub" style="margin-top:8px">${esc(headLine)}</p>`) +
        `<div class="sec state-out"><h2>${esc(heading)}</h2>` +
        `<p>${esc(clause)} Speakers already confirmed are on the speakers page.</p>` +
        `<a class="btn btn-primary" href="/${esc(slug)}/speakers">See who is speaking →</a></div>` +
        (open && !embed
          ? '<p class="sub" style="margin-top:14px">Still time to be one of them — ' +
            `<a class="link" href="/${esc(slug)}/cfp">submit a talk</a>.</p>`
          : '') +
        '</div>';
    } else {
      inner = agendaBody(event, ag, f, slug, roles, stars, link);
    }

    const body =
      (embed ? `<div class="stage onstage embed"><main>${inner}</main></div>` : onstageShell(nav, inner, slug)) +
      (stars.kind === 'local' && ag.published ? `<script>${String(agendaStarsIsland)}</script>` : '');

    // Signed in, the stars on this page are one person's own: never held in a
    // shared cache anywhere (the same rule my schedule keeps).
    if (principal) c.header('cache-control', 'private, no-store');

    return c.html(
      page({
        title: `${event.name} — Agenda`,
        description: `The public schedule for ${event.name}.`,
        register: 'onstage',
        body,
      })
    );
  });

  app.get('/:event/s/:slug', async (c) => {
    const slug = c.req.param('event');
    const sessionSlug = c.req.param('slug');
    const db = c.env.DB;
    const event = await eventBySlug(db, slug);
    if (!event) return c.notFound();
    const session = await sessionBySlug(db, event.id, sessionSlug);
    if (!session) return c.notFound();

    const embed = c.req.query('embed') === '1';
    const nav = eventNav(slug, '/agenda', event.lifecycle === 'open');

    const strike = session.cancelled ? ' style="text-decoration:line-through;text-decoration-color:var(--muted-2)"' : '';
    const roomLine = joinParts([
      `${weekdayDate(session.day, 'long')}, ${timeRange(session.startsAt, session.minutes, session.timezone)}`,
      session.roomName,
    ]);
    const cancelledNote = session.cancelled
      ? `<p class="sub" style="margin-top:6px">${esc(label('submission.cancelled', 'onstage'))}${session.cancelNote ? ` — ${esc(session.cancelNote)}` : ''}</p>`
      : '';
    // session.recordingUrl null → no CTA at all. labels.ts's mirror fact,
    // 'session.no_recording', has no onstage string (§6 marks it "—"): the
    // public page says nothing about an absent recording, it just omits it.
    const recordingCta = session.recordingUrl
      ? `<a class="btn btn-primary" href="${esc(session.recordingUrl)}">${esc(label('session.recording', 'onstage'))} →</a>`
      : '';
    // A plain link to this one session as a calendar file (registerIcs,
    // src/routes/public/ics.ts) — quiet, next to the time and room it
    // describes, same in embed mode since this block isn't embed-gated.
    const icsLink = `<p class="sub" style="margin-top:6px"><a class="link" href="/${esc(slug)}/s/${esc(sessionSlug)}.ics">Add to calendar →</a></p>`;

    const speakerBlocks = session.speakers.map((p) => speakerBlock(slug, p)).join('');

    const abstractHtml = session.abstract
      ? `<div class="sec abstract">${session.abstract
          .split('\n')
          .filter((p) => p.trim().length > 0)
          .map((p) => `<p>${esc(p)}</p>`)
          .join('')}</div>`
      : '';

    const inner =
      '<div class="wrap" style="padding-top:36px">' +
      `<p class="sub"><a class="link" href="/${esc(slug)}/agenda">← The agenda</a></p>` +
      '<div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;margin-top:14px">' +
      '<div style="flex:1;min-width:min(100%,320px)">' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">' +
      trackBadge(session.track) +
      `<span class="sub">${esc(formatLabel(session.format))} · ${esc(durationLabel(session.minutes))}</span></div>` +
      `<h1 class="display" style="font-size:clamp(27px,4.4vw,40px)"${strike}>${esc(session.title)}</h1>` +
      cancelledNote +
      `<p style="margin-top:14px;font-size:19px;font-weight:600">${esc(roomLine)}</p>` +
      (session.tzLabel ? `<p class="sub">${esc(session.tzLabel)}</p>` : '') +
      icsLink +
      '</div>' +
      (recordingCta ? `<div class="card card-pad" style="min-width:210px">${recordingCta}</div>` : '') +
      '</div>' +
      abstractHtml +
      (speakerBlocks
        ? `<div class="sec"><h2 class="display" style="font-size:24px;margin-bottom:14px">${session.speakers.length > 1 ? 'The speakers' : 'The speaker'}</h2>${speakerBlocks}</div>`
        : '') +
      '</div>';

    const body = embed ? `<div class="stage onstage embed"><main>${inner}</main></div>` : onstageShell(nav, inner, slug);

    return c.html(
      page({
        title: `${session.title} — ${event.name}`,
        description: `${session.title}, part of the program at ${event.name}.`,
        register: 'onstage',
        body,
      })
    );
  });
}
