// Calendar exports — S-6/S-7's quiet companion: the agenda, one session, or
// a visitor's own picks, as a file a phone or desktop calendar already knows
// how to open. No account, no spinner, same public-read rule as agenda.ts:
// a session that is not on the public agenda does not exist here either.
//
// Register note: an .ics file is not HTML, so esc() (html.ts's HTML escaper)
// does not apply — RFC 5545 §3.3.11 has its own escaping (backslash,
// semicolon, comma, newline), implemented once below as icsText() and used
// on every dynamic value, same spirit as the "every dynamic string escaped"
// law, different alphabet. State words still go through lib/labels.ts: a
// cancelled talk reads "Cancelled" here exactly as it does on the session
// page, onstage register (the audience for a downloaded calendar file is
// the same visitor as the audience for the page they downloaded it from).
//
// DTSTAMP: RFC 5545 wants "the instant this calendar object was created."
// The honest per-event constant would be event.created_at, but that column
// isn't exposed by any DTO in queries/public.ts, and this parcel's file
// discipline forbids touching that file to add it. Date.now(), read once
// per request and reused for every VEVENT in the same response, is the
// fallback the task brief explicitly sanctions ("Date.now() is fine to
// avoid if you can") — it makes DTSTAMP internally consistent within one
// document, at the cost of the document not being byte-identical across
// two requests. Flagged here and in the report; a one-line addition to
// EventHome (createdAt: r.created_at) is the durable fix.
import type { Hono } from 'hono';
import type { Env } from '../../index';
import { label } from '../../lib/labels';
import {
  agenda,
  eventBySlug,
  sessionBySlug,
  type AgendaSession,
  type PublicSpeaker,
  type SpeakerRef,
  type TrackRef,
} from '../../queries/public';
import { socialView } from '../../queries/social';
import { principalFromCookie } from '../../workflows/account';

/* ------------------------------------------------------------------ *
 * RFC 5545 primitives — escaping, folding, date formatting. Small and
 * local on purpose: no other parcel needs an ICS writer, and a shared
 * lib.ts entry is not this task's file to open.
 * ------------------------------------------------------------------ */

/** §3.3.11 TEXT escaping. Backslash first, or the escapes below would
 *  themselves get escaped on the next line. */
function icsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** epoch ms → "YYYYMMDDTHHMMSSZ", always UTC (the brief's own instruction:
 *  DTSTART/DTEND come from starts_at in UTC, no VTIMEZONE component). */
function icsDateUTC(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** §3.1 line folding: no content line over 75 octets. Splits on UTF-8 byte
 *  count, never mid-character, and CRLF + one leading space on every
 *  continuation (that space itself spends one of the next line's 75). */
function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  let out = '';
  let cur = '';
  let curBytes = 0;
  let budget = 75;
  for (const ch of line) {
    const chBytes = enc.encode(ch).length;
    if (curBytes + chBytes > budget) {
      out += cur + '\r\n ';
      cur = '';
      curBytes = 0;
      budget = 74; // continuation lines: 75 minus the leading space
    }
    cur += ch;
    curBytes += chBytes;
  }
  return out + cur;
}

/** One VEVENT, as a list of unfolded content lines — folding happens once,
 *  at final assembly, so every line (including the calendar wrapper) gets it. */
function vevent(o: {
  uid: string;
  dtstampMs: number;
  startsAtMs: number;
  minutes: number;
  summary: string;
  location: string | null;
  description: string | null;
  url: string | null;
  cancelled: boolean;
}): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${icsText(o.uid)}`,
    `DTSTAMP:${icsDateUTC(o.dtstampMs)}`,
    `DTSTART:${icsDateUTC(o.startsAtMs)}`,
    `DTEND:${icsDateUTC(o.startsAtMs + o.minutes * 60000)}`,
    `SUMMARY:${icsText(o.summary)}`,
    `STATUS:${o.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
  ];
  if (o.location) lines.push(`LOCATION:${icsText(o.location)}`);
  if (o.description) lines.push(`DESCRIPTION:${icsText(o.description)}`);
  if (o.url) lines.push(`URL:${o.url}`);
  lines.push('END:VEVENT');
  return lines;
}

function calendar(events: string[][]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fireside//Agenda//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...events.flat(),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

const ICS_HEADERS = (filename: string): Record<string, string> => ({
  'content-type': 'text/calendar; charset=utf-8',
  'content-disposition': `attachment; filename="${filename}"`,
});

/* ------------------------------------------------------------------ *
 * DESCRIPTION body: "speakers + track", the one line both AgendaSession
 * (agenda.ics, my-picks.ics) and PublicSession (the one-session route)
 * can supply — the two speaker-ref shapes share name + role only.
 * ------------------------------------------------------------------ */

function describeSession(
  speakers: (SpeakerRef | PublicSpeaker)[],
  track: TrackRef | null,
  cancelled: boolean,
  cancelNote: string | null
): string | null {
  const parts: string[] = [];
  if (speakers.length) parts.push(`Speakers: ${speakers.map((p) => p.name).join(', ')}`);
  if (track) parts.push(`Track: ${track.name}`);
  if (cancelled) {
    parts.push(cancelNote ? `${label('submission.cancelled', 'onstage')} — ${cancelNote}` : label('submission.cancelled', 'onstage'));
  }
  return parts.length ? parts.join('\n') : null;
}

function agendaSessionEvent(origin: string, eventSlug: string, dtstampMs: number, s: AgendaSession): string[] {
  return vevent({
    uid: `${s.id}@fireside`,
    dtstampMs,
    startsAtMs: s.startsAt,
    minutes: s.minutes,
    summary: s.title,
    location: s.roomName,
    description: describeSession(s.speakers, s.track, s.cancelled, null),
    url: s.publicSlug ? `${origin}/${encodeURIComponent(eventSlug)}/s/${encodeURIComponent(s.publicSlug)}` : null,
    cancelled: s.cancelled,
  });
}

/* ------------------------------------------------------------------ *
 * Routes.
 * ------------------------------------------------------------------ */

export function registerIcs(app: Hono<{ Bindings: Env }>): void {
  // GET /:event/agenda.ics — the whole published agenda, one VEVENT per
  // placed, non-cancelled session. Unpublished (or unknown) → 404, same
  // rule as the HTML agenda: nothing to export before there's an agenda.
  app.get('/:event/agenda.ics', async (c) => {
    const slug = c.req.param('event');
    const db = c.env.DB;
    const event = await eventBySlug(db, slug);
    if (!event) return c.notFound();
    const ag = await agenda(db, event.id);
    if (!ag || !ag.published) return c.notFound();

    const origin = new URL(c.req.url).origin;
    const dtstampMs = Date.now();
    const sessions = ag.days.flatMap((d) => d.slots.flatMap((sl) => sl.sessions)).filter((s) => !s.cancelled);
    const body = calendar(sessions.map((s) => agendaSessionEvent(origin, slug, dtstampMs, s)));
    return c.body(body, 200, ICS_HEADERS(`${slug}-agenda.ics`));
  });

  // GET /:event/my-picks.ics?ids=a,b,c — the visitor's own starred sessions.
  // ids are validated against this event's own placed, published sessions
  // (the same set agenda.ics draws from); anything else is silently
  // dropped — a stale or foreign id is not this route's problem to explain.
  // Cancelled picks are kept (STATUS:CANCELLED) rather than vanished: a
  // visitor who starred a talk before it was pulled still gets told so.
  app.get('/:event/my-picks.ics', async (c) => {
    const slug = c.req.param('event');
    const db = c.env.DB;
    const event = await eventBySlug(db, slug);
    if (!event) return c.notFound();
    const ag = await agenda(db, event.id);
    if (!ag) return c.notFound();

    const requested = [...new Set((c.req.query('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
    if (!requested.length) return c.notFound();

    const bySessionId = new Map(ag.days.flatMap((d) => d.slots.flatMap((sl) => sl.sessions)).map((s) => [s.id, s]));
    const matched = requested.map((id) => bySessionId.get(id)).filter((s): s is AgendaSession => Boolean(s));
    if (!matched.length) return c.notFound();

    const origin = new URL(c.req.url).origin;
    const dtstampMs = Date.now();
    const body = calendar(matched.map((s) => agendaSessionEvent(origin, slug, dtstampMs, s)));
    return c.body(body, 200, ICS_HEADERS(`${slug}-my-picks.ics`));
  });

  // GET /:event/my-schedule.ics[?ids=a,b,c] — the visitor's own starred
  // sessions, wired for both halves of the same promise the HTML my-schedule
  // page keeps: signed in, this reads straight from the account's own
  // starred list (socialView, same source my-schedule.ts and the agenda
  // page's account-mode star bar already read) with no ids= needed at all —
  // a visitor cannot be handed somebody else's calendar by guessing this
  // address. Signed out, the picks live only in this browser's localStorage,
  // so the same ?ids= contract my-picks.ics already answers is the only way
  // a server-rendered file can name them. This is the guessable address the
  // widget-polish pass named (my-picks.ics existed; this one 404'd).
  app.get('/:event/my-schedule.ics', async (c) => {
    const slug = c.req.param('event');
    const db = c.env.DB;
    const event = await eventBySlug(db, slug);
    if (!event) return c.notFound();
    const ag = await agenda(db, event.id);
    if (!ag) return c.notFound();

    const principal = await principalFromCookie(db, c.env.SESSION_SECRET, c.req.header('cookie'));
    const ids = principal
      ? (await socialView(db, event.id, principal.personId)).mine.starred
      : [...new Set((c.req.query('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
    if (!ids.length) return c.notFound();

    const bySessionId = new Map(ag.days.flatMap((d) => d.slots.flatMap((sl) => sl.sessions)).map((s) => [s.id, s]));
    const matched = ids.map((id) => bySessionId.get(id)).filter((s): s is AgendaSession => Boolean(s));
    if (!matched.length) return c.notFound();

    const origin = new URL(c.req.url).origin;
    const dtstampMs = Date.now();
    const body = calendar(matched.map((s) => agendaSessionEvent(origin, slug, dtstampMs, s)));
    // Signed in, this file is one person's own picks — never held in a shared
    // cache anywhere (the same rule the HTML page and the account-mode star
    // bar keep). Signed out it is exactly my-picks.ics's own shape, and
    // carries no more than that route already does.
    if (principal) c.header('cache-control', 'private, no-store');
    return c.body(body, 200, ICS_HEADERS(`${slug}-my-schedule.ics`));
  });

  // GET /:event/s/:slug.ics — one session. The route pattern keeps the
  // literal ".ics" suffix inside the regex-constrained param (Hono 4.13's
  // reg-exp-router throws building a matcher for a param immediately
  // followed by a literal outside the braces, e.g. `:slug{[^.]+}.ics` —
  // verified against the pinned version in node_modules before choosing
  // this shape) and the handler strips the suffix itself.
  app.get('/:event/s/:slugIcs{[a-z0-9-]+\\.ics}', async (c) => {
    const slug = c.req.param('event');
    const raw = c.req.param('slugIcs');
    const sessionSlug = raw.slice(0, -'.ics'.length);
    const db = c.env.DB;
    const event = await eventBySlug(db, slug);
    if (!event) return c.notFound();
    const session = await sessionBySlug(db, event.id, sessionSlug);
    if (!session) return c.notFound();

    const origin = new URL(c.req.url).origin;
    const dtstampMs = Date.now();
    const ev = vevent({
      uid: `${session.id}@fireside`,
      dtstampMs,
      startsAtMs: session.startsAt,
      minutes: session.minutes,
      summary: session.title,
      location: session.roomName,
      description: describeSession(session.speakers, session.track, session.cancelled, session.cancelNote),
      url: `${origin}/${encodeURIComponent(slug)}/s/${encodeURIComponent(sessionSlug)}`,
      cancelled: session.cancelled,
    });
    const body = calendar([ev]);
    return c.body(body, 200, ICS_HEADERS(`${sessionSlug}.ics`));
  });
}
