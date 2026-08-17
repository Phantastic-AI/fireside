// EMB-15 — the addresses that put this program on somebody else's page.
//
// Every conference already has a website, and it was built long before the
// program existed. This screen is for whoever keeps that site: six addresses,
// each one ready to paste, each with a sentence saying where it goes. Nothing
// here is a new capability — the public agenda and the speaker gallery have
// answered ?embed=1 all along, and the calendar files have been sitting at
// their own addresses. What was missing was anybody being told.
//
// Backstage register: plain, exact, no persuasion. The reader is doing a job
// with a text editor open in another window.
//
// Auth is the green room's shape exactly: a Principal from the cookie, the
// slug resolved through adminEvents (so an event that is not theirs is not
// found rather than refused with detail), then requireScope on READ_ROLES —
// these are public addresses, so reading them asks no more than reading the
// program does.
//
// The read is queries/admin.ts `adminEvents` and queries/public.ts `agenda`
// (for the days and tracks the one-day and one-track examples name). No
// writes: nothing on this screen changes anything.
//
// Not this file's to do, and flagged in the report rather than reached for:
// the nav link that gets a reader here lives in lib/html.ts's BS_NAV, and the
// registration lives in src/index.ts. Both belong to the integrator.
import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, backstageShell, deniedPage } from '../../lib/html';
import {
  adminEvents,
  requireScope,
  READ_ROLES,
  ScopeError,
  type AdminEvent,
} from '../../queries/admin';
import { agenda, type AgendaSession } from '../../queries/public';
import { reviewerOnly } from '../../queries/settings';
import { principalFromCookie, type Principal } from '../../workflows/account';
// @ts-ignore -- plain-JS island; see cfp.ts for the same note.
import embedCopyIsland from '../../islands/embed-copy.js';

/* ------------------------------------------------------------------ *
 * Small words — local, matching this build's per-file convention.
 * ------------------------------------------------------------------ */

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((p) => p !== '')
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '·';

function cap(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** A day key ("2026-09-03") as a person says it. Wall dates format in UTC. */
function dayWords(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)));
}

/** Safe inside a copied `title="…"` — the one character that would break it. */
function attrText(s: string): string {
  return s.replace(/"/g, '');
}

async function eventFor(
  db: D1Database,
  principal: Principal,
  slug: string
): Promise<AdminEvent | undefined> {
  const events = await adminEvents(db, principal);
  const ev = events.find((e) => e.slug === slug);
  // A reviewer holds the reading room and nothing else — handing the program
  // out to the world is not theirs, so this screen is the plain refusal.
  return ev && reviewerOnly(principal, ev.id) ? undefined : ev;
}

/* ------------------------------------------------------------------ *
 * One block: a heading, one sentence, and the thing to copy.
 * ------------------------------------------------------------------ */

function block(title: string, sentence: string, snippet: string): string {
  return (
    '<div class="card card-pad" style="margin-bottom:14px;max-width:56em">' +
    `<h2 style="font-size:16px;font-weight:700;margin:0">${esc(title)}</h2>` +
    `<p class="sub" style="margin:6px 0 10px">${esc(sentence)}</p>` +
    `<textarea readonly rows="3" aria-label="${esc(title)}" data-copy-source ` +
    'style="width:100%;font-family:var(--mono);font-size:12.5px;line-height:1.5;' +
    `background:var(--paper-deep)">${esc(snippet)}</textarea>` +
    '</div>'
  );
}

function frame(src: string, title: string, height: number): string {
  return (
    `<iframe src="${src}" title="${attrText(title)}" width="100%" height="${height}" ` +
    'style="border:0;width:100%" loading="lazy"></iframe>'
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

function embedsPage(
  principal: Principal,
  ev: AdminEvent,
  origin: string,
  published: boolean,
  firstDay: string | null,
  firstTrack: { slug: string; name: string } | null,
  pickIds: string[]
): string {
  const at = `${origin}/${encodeURIComponent(ev.slug)}`;

  const notPublished = published
    ? ''
    : '<div class="sec attn" style="max-width:56em"><div><div class="lab">The program is not public yet.</div>' +
      '<div class="why">Paste them now anyway. They fill in the moment you publish the program, ' +
      'and nothing on the other site needs changing then.</div></div></div>';

  const parts: string[] = [
    block(
      'The whole program',
      'The published agenda, with its own search and its day, track and kind chips. Paste this where the schedule page lives.',
      frame(`${at}/agenda?embed=1`, `${ev.name} — program`, 900)
    ),
    block(
      'Who is speaking',
      'The speaker gallery, faces and all. Paste this where the speakers page lives.',
      frame(`${at}/speakers?embed=1`, `${ev.name} — speakers`, 800)
    ),
    // T610 — the program as data and as paper, for the sites that want to
    // draw it themselves or take it without a script.
    block(
      'The program as JSON',
      'Every session with its time, room, track, speakers and roles — live as the program changes, open to any origin. Narrow it with ?day=2026-09-03 or ?track=platform.',
      `${at}/agenda.json`
    ),
    block(
      'The speakers as JSON',
      'The gallery as data: name, title, employer, and the address of each speaker page.',
      `${at}/speakers.json`
    ),
    block(
      'The program as plain HTML',
      'One self-contained page: no script, no styles to fight, safe anywhere that takes markup. The iframe stays the living version; this one is paper.',
      `${at}/agenda.html`
    ),
    ...(firstDay
      ? [block(
          `One day — ${dayWords(firstDay)}`,
          'The same program narrowed to one day. Change the date in the address for the other days.',
          frame(`${at}/agenda?embed=1&day=${firstDay}`, `${ev.name} — ${dayWords(firstDay)}`, 700)
        )]
      : []),
    ...(firstTrack
      ? [block(
          `One track — ${firstTrack.name}`,
          'The same program narrowed to one track, for a page that is about that subject. Change the track in the address for the others.',
          frame(
            `${at}/agenda?embed=1&track=${encodeURIComponent(firstTrack.slug)}`,
            `${ev.name} — ${firstTrack.name}`,
            700
          )
        )]
      : []),
    block(
      'The program, as a calendar file',
      'The whole program as a calendar file. Link it as "add to calendar", or point a calendar subscription at it.',
      `${at}/agenda.ics`
    ),
    block(
      'One person’s starred sessions, as a calendar file',
      'The sessions one visitor starred, as a calendar file. Their sessions go on the end of the address, separated by commas.',
      `${at}/my-picks.ics?ids=${pickIds.join(',')}`
    ),
  ];
  const blocks = parts.join('');

  const head =
    '<div style="padding:26px 0 0"><h1 class="display">Put the program on your site</h1>' +
    `<p class="counts"><b>${parts.length} addresses</b><span class="sep">·</span>` +
    'each one live, each one current as the program changes</p></div>' +
    '<p class="sub" style="max-width:56em;margin:10px 0 18px">Every address below is public and needs no ' +
    'sign-in.</p>';

  return page({
    title: `Embeds · ${ev.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: ev.slug,
      eventName: ev.name,
      here: '/embeds',
      who: `${principal.name} · ${cap(ev.standing)}`,
      whoInitials: initialsOf(principal.name),
      tzLabel: ev.tzLabel ?? ev.timezone,
      crumb: `<a href="/admin/${esc(ev.slug)}">Program</a> › <span>Embeds</span>`,
      body: head + notPublished + blocks + `<script>${String(embedCopyIsland)}</script>`,
    }),
  });
}

/* ------------------------------------------------------------------ *
 * Routes.
 * ------------------------------------------------------------------ */

export function registerEmbeds(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/:eventSlug/embeds', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');

    const slug = c.req.param('eventSlug');
    try {
      const ev = await eventFor(c.env.DB, principal, slug);
      if (!ev) return c.html(deniedPage(), 403);
      requireScope(principal, ev.id, READ_ROLES);

      // The public read, so the examples name this event's own first day and
      // first track rather than something invented.
      const ag = await agenda(c.env.DB, ev.id);
      const sessions: AgendaSession[] = ag ? ag.days.flatMap((d) => d.slots.flatMap((sl) => sl.sessions)) : [];
      const firstDay = ag?.days[0]?.day ?? null;
      const firstTrack = sessions.find((s) => s.track !== null)?.track ?? null;
      const pickIds = sessions.slice(0, 2).map((s) => s.id);

      const origin = new URL(c.req.url).origin;
      return c.html(
        embedsPage(
          principal,
          ev,
          origin,
          ag?.published === true,
          firstDay,
          firstTrack ? { slug: firstTrack.slug, name: firstTrack.name } : null,
          pickIds
        )
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });
}
