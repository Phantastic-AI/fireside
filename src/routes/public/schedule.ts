// S-10 — My schedule, anonymous-first. #/{event}/my-schedule
//
// The whole feature lives in the browser: a starred-session id list in
// localStorage, keyed by event slug. The server's only jobs are to shape the
// published agenda into a small, pre-formatted payload (times and day labels
// baked in, so the island never touches a timezone) and to hand the visitor
// a quiet door to sign in — offered only after the list already has
// something in it, never before.
//
// The star controls on THIS page only. The agenda page's own star controls
// are a later parcel and are not touched here.
//
// Persona: Dani, "drinking from a firehose" — this is the page that turns
// scattered starring into one readable list, on one bar of signal.
//
// Gap routed around — queries/portal.ts has no read for a signed-in
// speaker's own `my_schedule` stars yet. principalFromCookie() below is used
// only to soften the sign-in nudge (a signed-in visitor sees "Signed in as
// {name}" instead of an invitation to sign in they've already accepted);
// their starred list itself still comes from localStorage, identically to
// an anonymous visitor. A real fix needs a query reading my_schedule rows
// for a personId, a merge on first sign-in (their stored stars ∪ whatever
// is already in this browser), and a write path so toggling here updates
// the server copy too — all of it belongs in queries/portal.ts and a
// workflow, not in a route file.
import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, onstageShell, eventNav } from '../../lib/html';
import { label, FORMAT_KEY } from '../../lib/labels';
import { eventBySlug, agenda, type Agenda, type SpeakerRef } from '../../queries/public';
import { principalFromCookie } from '../../workflows/account';

// The island's source, served at /a/stars.js. Imported as raw text via the
// wrangler Text rule for src/islands/*.js (see wrangler.jsonc) — it is a
// browser script and must never be bundled as a Worker module.
import starsJs from '../../islands/stars.js';

/* ------------------------------------------------------------------ *
 * Server-side shaping: the agenda DTO, formatted once, into exactly what
 * the island needs to paint a row — no timezone or date math left for it.
 * ------------------------------------------------------------------ */

type EmbeddedSession = {
  id: string;
  slug: string | null;
  title: string;
  time: string;
  room: string | null;
  format: string;
  minutes: string;
  track: { name: string; colour: string } | null;
  cancelled: boolean;
  cancelledLabel: string;
  speakers: string;
};

type EmbeddedDay = { label: string; sessions: EmbeddedSession[] };

type EmbeddedAgenda = { slug: string; days: EmbeddedDay[] };

function fmtTime(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(
    new Date(ms)
  );
}

function fmtDayLabel(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  }).format(new Date(ms));
}

function fmtMinutes(m: number): string {
  return m >= 90 && m % 60 === 0 ? `${m / 60} hr` : `${m} min`;
}

/** FORMAT_KEY (lib/labels.ts, Δ CP1) maps the stored casing to a label key —
 *  this is the one place a session's format word touches label(). */
function formatLabel(format: string): string {
  const key = FORMAT_KEY[format];
  return key ? label(key, 'onstage') : format;
}

/** Names only — the DTO carries no per-speaker organisation on the agenda. */
function byline(speakers: SpeakerRef[]): string {
  const names = speakers
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((s) => s.name);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

function buildEmbed(slug: string, ag: Agenda): EmbeddedAgenda {
  const days: EmbeddedDay[] = ag.days.map((d) => {
    const sessions: EmbeddedSession[] = [];
    for (const slot of d.slots) {
      for (const s of slot.sessions) {
        sessions.push({
          id: s.id,
          slug: s.publicSlug,
          title: s.title,
          time: fmtTime(s.startsAt, ag.timezone),
          room: s.roomName,
          format: formatLabel(s.format),
          minutes: fmtMinutes(s.minutes),
          track: s.track ? { name: s.track.name, colour: s.track.colour } : null,
          cancelled: s.cancelled,
          cancelledLabel: s.cancelled ? label('submission.cancelled', 'onstage') : '',
          speakers: byline(s.speakers),
        });
      }
    }
    const firstStart = d.slots[0]?.sessions?.[0]?.startsAt;
    return { label: firstStart !== undefined ? fmtDayLabel(firstStart, ag.timezone) : d.day, sessions };
  });
  return { slug, days };
}

/** JSON for a `<script type="application/json">` block: JS-safe, not HTML-safe
 *  — esc() would double-escape quotes JSON already owns. The one thing that
 *  matters here is never letting a literal `</script` end the block early. */
function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

export function registerSchedule(app: Hono<{ Bindings: Env }>): void {
  app.get('/a/stars.js', (c) =>
    c.body(starsJs, 200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
    })
  );

  app.get('/:event/my-schedule', async (c) => {
    const ev = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!ev) return c.notFound();

    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    const ag: Agenda = (await agenda(c.env.DB, ev.id)) ?? {
      eventId: ev.id,
      timezone: ev.timezone,
      tzLabel: ev.tzLabel,
      published: false,
      days: [],
    };
    const embed = buildEmbed(ev.slug, ag);

    const signOn = principal
      ? `<p class="hint" style="margin-top:22px">${esc(
          label('auth.signed_in', 'onstage').split('{name}').join(principal.name)
        )}</p>`
      : '<p class="hint" style="margin-top:22px"><a class="link" href="/sign-in">Signing in keeps this list on every device</a></p>';

    const inner =
      '<div class="wrap" style="padding-top:44px">' +
      '<h1 class="display">My schedule</h1>' +
      `<p class="sub" style="margin-top:8px">${esc(ev.name)}${ev.tzLabel ? ` · ${esc(ev.tzLabel)}` : ''}</p>` +
      '<div id="my-schedule-root" class="sec">' +
      '<noscript><div class="sec state-out"><h2>Turn on scripts to see your list.</h2>' +
      '<p>Starred sessions are kept in this browser and shown here once scripts run.</p>' +
      `<a class="btn btn-primary" href="/${esc(ev.slug)}/agenda">Browse the agenda →</a></div></noscript>` +
      '</div>' +
      `<script type="application/json" id="my-schedule-data">${safeJson(embed)}</script>` +
      signOn +
      '</div>';

    const body =
      onstageShell(eventNav(ev.slug, '/my-schedule', ev.lifecycle === 'open'), inner) +
      '<script src="/a/stars.js" defer></script>';

    return c.html(
      page({
        title: `My schedule · ${ev.name}`,
        description: `Your starred sessions at ${ev.name}, kept in this browser.`,
        register: 'onstage',
        body,
      })
    );
  });
}
