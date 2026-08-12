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

/* ------------------------------------------------------------------ *
 * The island's source, served at /a/stars.js.
 *
 * This is a byte-for-byte copy of src/islands/stars.js. It is inlined here
 * rather than imported because wrangler's module rules only give raw text
 * for `**\/*.css` today (see wrangler.jsonc) — there is no such rule for
 * `.js`, so `import stars from '../../islands/stars.js'` would have esbuild
 * bundle it as a Worker module and execute its top-level `document.*` calls
 * in the Worker's global scope, which has no `document` and would crash the
 * whole site on load. Until a shared-infra pass adds a text rule for
 * `src/islands/**` (and a matching `declare module` in src/types.d.ts,
 * mirroring the existing `*.css` one), this file and the served one must be
 * kept in sync by hand. src/islands/stars.js carries the same note.
 * ------------------------------------------------------------------ */
const STARS_JS = `// stars.js — the "my schedule" island (S-10, /:event/my-schedule).
//
// Everyone's schedule here starts anonymous: a list of starred session ids in
// localStorage, keyed by event slug, so it works with no account and nothing
// sent anywhere. This file only reads that list, writes it back on toggle,
// and paints rows the server already put in time order — no date math here,
// times and day labels arrive pre-formatted in the embedded JSON.
//
// Kept in sync by hand with the STARS_JS constant in
// ../routes/public/schedule.ts, which serves this file's exact text at
// /a/stars.js (see that file's header comment for why).
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function plural(n, one, many) {
    return n === 1 ? '1 ' + one : n + ' ' + many;
  }

  // Every row on this page is, by definition, a starred one — the button
  // here is always the filled star; the hollow "star it" state belongs to
  // the agenda page's own controls, a later parcel.
  var STAR_ON =
    '<svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">' +
    '<path d="M12 3.2l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.7l6.1-.9z"/></svg>';

  var root = document.getElementById('my-schedule-root');
  if (!root) return;
  var dataEl = document.getElementById('my-schedule-data');
  var data = { slug: '', days: [] };
  try {
    data = JSON.parse((dataEl && dataEl.textContent) || '{}');
  } catch (e) {
    /* leave data empty — render() below shows the empty state */
  }

  var KEY = 'fireside.stars.' + data.slug;
  function stars() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch (e) {
      return [];
    }
  }
  function toggleStar(id) {
    var a = stars(),
      i = a.indexOf(id);
    if (i < 0) a.push(id);
    else a.splice(i, 1);
    try {
      localStorage.setItem(KEY, JSON.stringify(a));
    } catch (e) {
      /* private browsing: the toggle still repaints this render */
    }
    return i < 0;
  }

  function row(s) {
    var track = s.track
      ? '<span class="tk" style="--tc:' + esc(s.track.colour) + ';--tw:' + esc(s.track.colour) + '22">' +
        esc(s.track.name) + '</span>'
      : '';
    var struck = s.cancelled ? ' style="text-decoration:line-through;color:var(--muted)"' : '';
    var title = s.slug
      ? '<a href="/' + esc(data.slug) + '/s/' + esc(s.slug) + '"' + struck + '>' + esc(s.title) + '</a>'
      : '<span' + struck + '>' + esc(s.title) + '</span>';
    return (
      '<article class="sesh" style="--tc:' + esc(s.track ? s.track.colour : '#726858') + '">' +
      '<div class="sesh-main"><div class="sesh-when"><span class="time">' + esc(s.time) + '</span>' +
      (s.room ? '<span class="room">' + esc(s.room) + '</span>' : '') + '</div>' +
      '<h3>' + title + '</h3>' +
      (s.speakers ? '<div class="sesh-by"><span>' + esc(s.speakers) + '</span></div>' : '') +
      '<div class="sesh-meta">' + track + '<span>' + esc(s.format) + ' · ' + esc(s.minutes) + '</span>' +
      (s.cancelled ? '<span class="chip plain" style="color:var(--danger)">' + esc(s.cancelledLabel) + '</span>' : '') +
      '</div></div>' +
      '<button class="starbtn" data-star="' + esc(s.id) + '" aria-pressed="true" aria-label="Remove from my schedule">' +
      STAR_ON + '</button></article>'
    );
  }

  function render() {
    var set = stars();
    var total = 0;
    var out = '';
    data.days.forEach(function (d) {
      var inDay = d.sessions.filter(function (s) {
        return set.indexOf(s.id) >= 0;
      });
      if (!inDay.length) return;
      total += inDay.length;
      out += '<div class="dayhead">' + esc(d.label) + '</div><div class="slot">' + inDay.map(row).join('') + '</div>';
    });

    if (!total) {
      root.innerHTML =
        '<div class="sec state-out"><h2>Nothing starred yet.</h2>' +
        '<p>Star a session on the agenda and it turns up here — kept in this browser, no account needed.</p>' +
        '<a class="btn btn-primary" href="/' + esc(data.slug) + '/agenda">Browse the agenda →</a></div>';
      return;
    }

    root.innerHTML =
      '<p class="sub" style="margin:2px 0 18px">' + plural(total, 'session starred', 'sessions starred') + '</p>' + out;

    root.querySelectorAll('[data-star]').forEach(function (b) {
      b.addEventListener('click', function () {
        toggleStar(b.dataset.star);
        render();
      });
    });
  }

  render();
})();
`;

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
    c.body(STARS_JS, 200, {
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
