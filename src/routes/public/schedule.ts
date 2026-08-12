// S-10 — My schedule. #/{event}/my-schedule
//
// Two pages at one address, and which one you get is the only thing signing in
// changes.
//
// SIGNED OUT — exactly what it has always been: a starred session id list in
// localStorage, keyed by event slug, painted by src/islands/stars.js. No row,
// no cookie, no account, nothing sent anywhere. The server's only jobs are to
// shape the published agenda into a small pre-formatted payload (times and day
// labels baked in, so the island never touches a timezone) and to say, once and
// quietly, what signing in would add.
//
// SIGNED IN — the same list, server-rendered from their own my_schedule rows,
// plus the three things a browser cannot hold: it follows them to another
// phone, they can choose to share it, and once they share it they can see who
// else is going. The browser's copy is handed over once, by the island, through
// the hidden adopt form below; nothing local is cleared until a later load
// proves the server has it.
//
// Sharing is off until asked for, twice: the choice opens, says in plain words
// what becomes visible, and only then offers the button (D-024 — this one
// leaves the building). Coming back off is one click, and takes effect on
// everybody else's next load, because reciprocity is a live join and not a
// stored audience (queries/social.ts).
//
// The read is queries/public.ts + queries/social.ts and nothing else; the
// writes are workflows/social.ts, which return an outcome word. The sentences
// for those outcomes live here, because they are the screen's.
//
// Persona: Dani, "drinking from a firehose" — this is the page that turns
// scattered starring into one readable list, and then into three people worth
// finding, on one bar of signal.
import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, onstageShell, eventNav } from '../../lib/html';
import { label, FORMAT_KEY } from '../../lib/labels';
import { eventBySlug, agenda, type Agenda, type SpeakerRef } from '../../queries/public';
import {
  socialView,
  type SocialView,
  type MyConnection,
  type PersonToFind,
} from '../../queries/social';
import { principalFromCookie } from '../../workflows/account';
import { setStar, adoptStars, setSharing, noteConnection } from '../../workflows/social';

// The island's source, served at /a/stars.js. Imported as raw text via the
// wrangler Text rule for src/islands/*.js (see wrangler.jsonc) — it is a
// browser script and must never be bundled as a Worker module.
import starsJs from '../../islands/stars.js';

/* ------------------------------------------------------------------ *
 * Server-side shaping: the agenda DTO, formatted once, into exactly what
 * a row needs — no timezone or date math left for the island, and the same
 * shape whether the row is painted here or there.
 * ------------------------------------------------------------------ */

type EmbeddedSession = {
  id: string;
  slug: string | null;
  title: string;
  time: string;
  at: number;
  mins: number;
  room: string | null;
  format: string;
  minutes: string;
  track: { name: string; colour: string } | null;
  cancelled: boolean;
  cancelledLabel: string;
  speakers: string;
};

type EmbeddedDay = { label: string; sessions: EmbeddedSession[] };

type EmbeddedAgenda = { slug: string; days: EmbeddedDay[]; signedIn: boolean; mine: string[] };

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

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
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

function buildEmbed(slug: string, ag: Agenda, signedIn: boolean, mine: string[]): EmbeddedAgenda {
  const days: EmbeddedDay[] = ag.days.map((d) => {
    const sessions: EmbeddedSession[] = [];
    for (const slot of d.slots) {
      for (const s of slot.sessions) {
        sessions.push({
          id: s.id,
          slug: s.publicSlug,
          title: s.title,
          time: fmtTime(s.startsAt, ag.timezone),
          at: s.startsAt,
          mins: s.minutes,
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
  return { slug, days, signedIn, mine };
}

/** JSON for a `<script type="application/json">` block: JS-safe, not HTML-safe
 *  — esc() would double-escape quotes JSON already owns. The one thing that
 *  matters here is never letting a literal `</script` end the block early. */
function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

/* ------------------------------------------------------------------ *
 * The signed-in list — the island's row, server-rendered, with the star
 * turned into a form so it works with scripts off.
 * ------------------------------------------------------------------ */

const STAR_ON =
  '<svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">' +
  '<path d="M12 3.2l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.7l6.1-.9z"/></svg>';

/** D-029 — the page never pretends time and distance away. Two facts only:
 *  starred sessions that overlap, and a room change with no room to breathe.
 *  Warnings never block a star; they are the honest mirror of the plan. */
function physicsNotes(rows: EmbeddedSession[]): Map<string, string[]> {
  const notes = new Map<string, string[]>();
  const add = (id: string, note: string) => {
    const list = notes.get(id) ?? [];
    if (!list.includes(note)) list.push(note);
    notes.set(id, list);
  };
  const live = rows.filter((s) => !s.cancelled).slice().sort((a, b) => a.at - b.at);
  for (let i = 0; i < live.length; i++) {
    const a = live[i]!;
    const aEnd = a.at + a.mins * 60_000;
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j]!;
      if (b.at < aEnd) {
        add(a.id, `Overlaps with ${b.title}.`);
        add(b.id, `Overlaps with ${a.title}.`);
        continue;
      }
      const gap = Math.round((b.at - aEnd) / 60_000);
      if (gap < 10 && a.room && b.room && a.room !== b.room) {
        add(b.id, gap === 0 ? `Tight turn — ${a.room} to ${b.room}, no gap.` : `Tight turn — ${a.room} to ${b.room}, ${gap} min.`);
      }
      break; // only the next session matters once nothing overlaps
    }
  }
  return notes;
}

function starRow(slug: string, s: EmbeddedSession, notes: string[] = []): string {
  const strike = s.cancelled ? ' style="text-decoration:line-through;color:var(--muted)"' : '';
  const title = s.slug
    ? `<a href="/${esc(slug)}/s/${esc(s.slug)}"${strike}>${esc(s.title)}</a>`
    : `<span${strike}>${esc(s.title)}</span>`;
  const track = s.track
    ? `<span class="tk" style="--tc:${esc(s.track.colour)};--tw:${esc(s.track.colour)}22">${esc(s.track.name)}</span>`
    : '';
  // The form wraps the card rather than sitting inside it: .slot is a column
  // flex box, so a form is a perfectly good flex item and the card inside it
  // lays out exactly as it does on the agenda. One control, no scripts.
  return (
    `<form method="post" action="/${esc(slug)}/my-schedule/star">` +
    `<article class="sesh" style="--tc:${esc(s.track ? s.track.colour : '#726858')}">` +
    `<div class="sesh-main"><div class="sesh-when"><span class="time">${esc(s.time)}</span>` +
    (s.room ? `<span class="room">${esc(s.room)}</span>` : '') +
    '</div>' +
    `<h3>${title}</h3>` +
    (s.speakers ? `<div class="sesh-by"><span>${esc(s.speakers)}</span></div>` : '') +
    `<div class="sesh-meta">${track}<span>${esc(s.format)} · ${esc(s.minutes)}</span>` +
    (s.cancelled
      ? `<span class="sub">· ${esc(s.cancelledLabel)}</span>`
      : '') +
    '</div>' +
    notes.map((n) => `<div class="sub" style="margin-top:6px;color:var(--danger)">${esc(n)}</div>`).join('') +
    '</div>' +
    `<input type="hidden" name="session" value="${esc(s.id)}">` +
    '<input type="hidden" name="on" value="0">' +
    '<button class="starbtn" type="submit" aria-pressed="true" aria-label="Take this off my schedule">' +
    `${STAR_ON}</button></article></form>`
  );
}

function serverList(slug: string, embed: EmbeddedAgenda, starred: string[]): string {
  const set = new Set(starred);
  let total = 0;
  let out = '';
  for (const d of embed.days) {
    const inDay = d.sessions.filter((s) => set.has(s.id));
    if (!inDay.length) continue;
    total += inDay.length;
    const notes = physicsNotes(inDay);
    out +=
      `<div class="dayhead">${esc(d.label)}</div>` +
      `<div class="slot">${inDay.map((s) => starRow(slug, s, notes.get(s.id) ?? [])).join('')}</div>`;
  }
  if (!total) {
    return (
      '<div class="sec state-out"><h2>Nothing starred yet.</h2>' +
      '<p>Star a session on the agenda and it turns up here, on whichever phone you open ' +
      'next.</p>' +
      `<a class="btn btn-primary" href="/${esc(slug)}/agenda">Browse the agenda →</a></div>`
    );
  }
  return (
    `<p class="sub" style="margin:2px 0 18px">${esc(plural(total, 'session starred', 'sessions starred'))}</p>` +
    out
  );
}

/* ------------------------------------------------------------------ *
 * The share choice
 * ------------------------------------------------------------------ */

/** The dashed-circle initials mark the gallery uses when there is no photo. */
function initialsMark(name: string, initials: string): string {
  return (
    `<svg class="av" width="34" height="34" viewBox="0 0 40 40" role="img" aria-label="${esc(name)}">` +
    '<circle cx="20" cy="20" r="19.2" fill="none" stroke="#D8CEBE" stroke-width="1.2" stroke-dasharray="3 3"/>' +
    '<text x="20" y="20" text-anchor="middle" dominant-baseline="central" ' +
    `font-family="ui-sans-serif,system-ui,sans-serif" font-size="13" font-weight="600" fill="#B4A996">${esc(initials)}</text></svg>`
  );
}

function linksLine(links: string): string {
  const parts = links.split(/[\s,]+/).map((p) => p.trim()).filter((p) => p !== '');
  if (!parts.length) return '';
  return parts
    .map((p) =>
      /^https:\/\/[^\s]+$/.test(p)
        ? `<a class="link" href="${esc(p)}" rel="noopener nofollow">${esc(p.replace(/^https:\/\//, ''))}</a>`
        : esc(p)
    )
    .join(' · ');
}

/** One opt-in row. The subtitle is the fact itself, so nobody has to guess what
 *  saying yes would put in front of a stranger. A fact they do not have is not
 *  offered — but a yes they already gave is carried through untouched. */
function optIn(name: string, title: string, fact: string | null, on: boolean): string {
  if (!fact) return on ? `<input type="hidden" name="${esc(name)}" value="1">` : '';
  return (
    `<label class="radio" style="margin-bottom:8px"><input type="checkbox" name="${esc(name)}" value="1"${on ? ' checked' : ''}>` +
    `<span><span class="rname">${esc(title)}</span><span class="rsub">${esc(fact)}</span></span></label>`
  );
}

function shareForm(slug: string, view: SocialView, buttonWord: string): string {
  const me = view.mine;
  const work = [me.jobTitle, me.organisation].filter((x) => x).join(' at ');
  return (
    `<form method="post" action="/${esc(slug)}/my-schedule/share" style="margin-top:12px">` +
    '<input type="hidden" name="on" value="1">' +
    '<p class="sub" style="margin-bottom:10px">Always visible: your name, and the sessions you starred. ' +
    'Everything below is yours to choose, one at a time.</p>' +
    optIn('work', 'Where you work', work === '' ? null : work, me.contact.work) +
    optIn('links', 'Your links', me.links, me.contact.links) +
    optIn('email', 'Your email address', me.email, me.contact.email) +
    `<div class="btnrow" style="margin-top:12px"><button class="btn btn-primary" type="submit">${esc(buttonWord)}</button></div>` +
    '</form>'
  );
}

function shareCard(slug: string, view: SocialView): string {
  const visibility = label('social.visibility', 'onstage');
  if (!view.mine.shareEnabled) {
    return (
      '<div class="card card-pad sec" style="max-width:46em">' +
      '<h2 class="serif" style="font-size:22px;font-weight:600;margin:0">Share what you are going to, ' +
      'and see who else is going.</h2>' +
      '<p class="sub" style="margin:8px 0 0">Nobody sees your list until you say so. When you do, the ' +
      'people going to the same talks show up here with their names — and you show up on theirs.</p>' +
      `<details style="margin-top:12px"><summary class="link" style="cursor:pointer">${esc(visibility)}</summary>` +
      shareForm(slug, view, 'Put me on the list') +
      '</details></div>'
    );
  }
  const shown = [
    'your name',
    view.mine.contact.work && view.mine.jobTitle ? 'where you work' : '',
    view.mine.contact.links && view.mine.links ? 'your links' : '',
    view.mine.contact.email && view.mine.email ? 'your email address' : '',
  ].filter((x) => x !== '');
  const last = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
  return (
    '<div class="card card-pad sec" style="max-width:46em">' +
    '<h2 class="serif" style="font-size:22px;font-weight:600;margin:0">You are on the list.</h2>' +
    `<p class="sub" style="margin:8px 0 0">People going to the same talks can see ${esc(last ?? 'your name')}, ` +
    'and the sessions you starred.</p>' +
    `<details style="margin-top:12px"><summary class="link" style="cursor:pointer">${esc(visibility)}</summary>` +
    shareForm(slug, view, 'Save what people can see') +
    '</details>' +
    `<form method="post" action="/${esc(slug)}/my-schedule/share" style="margin-top:14px">` +
    '<input type="hidden" name="on" value="0">' +
    `<button class="btn btn-quiet" type="submit">${esc(label('social.revoke', 'onstage'))}</button></form>` +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * People to find
 * ------------------------------------------------------------------ */

function personCard(slug: string, p: PersonToFind): string {
  const facts: string[] = [];
  const work = [p.jobTitle, p.organisation].filter((x) => x).join(' at ');
  if (work) facts.push(esc(work));
  if (p.links) {
    const line = linksLine(p.links);
    if (line) facts.push(line);
  }
  if (p.email) facts.push(`<a class="link" href="mailto:${esc(p.email)}">${esc(p.email)}</a>`);

  const together = p.sessions
    .map((s) =>
      s.publicSlug
        ? `<a class="link" href="/${esc(slug)}/s/${esc(s.publicSlug)}">${esc(s.title)}</a>`
        : esc(s.title)
    )
    .join(' · ');

  const open = p.sessions.filter((s) => !s.noted);
  const chooser =
    open.length > 1
      ? `<select name="session" aria-label="Which session">${open
          .map((s) => `<option value="${esc(s.submissionId)}">${esc(s.title)}</option>`)
          .join('')}</select>`
      : `<input type="hidden" name="session" value="${esc(open[0]?.submissionId ?? '')}">`;

  const form = open.length
    ? `<form method="post" action="/${esc(slug)}/my-schedule/connect" style="margin-top:12px">` +
      `<input type="hidden" name="person" value="${esc(p.personId)}">` +
      (open.length > 1 ? `<div style="margin-bottom:8px">${chooser}</div>` : chooser) +
      `<label class="f-lab" for="note-${esc(p.personId)}">Something to say when you find them</label>` +
      `<input type="text" name="note" id="note-${esc(p.personId)}" maxlength="280" ` +
      'placeholder="Ask about the queue-depth question">' +
      `<div class="btnrow" style="margin-top:10px"><button class="btn btn-sm" type="submit">${esc(
        label('social.remind', 'onstage')
      )}</button></div></form>`
    : '<p class="hint" style="margin-top:10px">Already on your list below.</p>';

  return (
    '<div class="card card-pad" style="margin-bottom:12px">' +
    `<div class="byline">${initialsMark(p.name, p.initials)}<span class="serif" style="font-size:19px;font-weight:600">${esc(p.name)}</span></div>` +
    (facts.length ? `<p class="sub" style="margin:8px 0 0">${facts.join(' · ')}</p>` : '') +
    `<p style="margin:10px 0 0;font-size:14.5px">Both going to ${together}</p>` +
    form +
    '</div>'
  );
}

function peopleSection(slug: string, view: SocialView): string {
  const head =
    `<h2 class="display" style="font-size:26px;margin-bottom:6px">${esc(label('social.list', 'onstage'))}</h2>`;
  if (!view.people.length) {
    return (
      '<div class="sec" style="max-width:46em">' +
      head +
      '<div class="state-out"><h2>Nobody else is sharing yet.</h2>' +
      '<p>The moment someone going to one of your sessions turns sharing on, they turn up here ' +
      'with their name and whatever they chose to show.</p>' +
      `<a class="btn btn-primary" href="/${esc(slug)}/agenda">Star a few more talks →</a></div></div>`
    );
  }
  return (
    '<div class="sec" style="max-width:46em">' +
    head +
    `<p class="sub" style="margin-bottom:14px">${esc(
      plural(view.people.length, 'person', 'people')
    )} starred something you starred, and chose to be found.</p>` +
    view.people.map((p) => personCard(slug, p)).join('') +
    '</div>'
  );
}

function connectionRow(slug: string, c: MyConnection): string {
  const title = c.publicSlug
    ? `<a class="link" href="/${esc(slug)}/s/${esc(c.publicSlug)}">${esc(c.title)}</a>`
    : esc(c.title);
  return (
    '<div class="card card-pad" style="margin-bottom:10px">' +
    `<div class="byline">${initialsMark(c.name, c.initials)}<span class="serif" style="font-size:18px;font-weight:600">${esc(c.name)}</span></div>` +
    `<p class="sub" style="margin:8px 0 0">From ${title}</p>` +
    (c.note ? `<div class="notebox" style="margin-top:10px">${esc(c.note)}</div>` : '') +
    '</div>'
  );
}

function connectionsSection(slug: string, view: SocialView): string {
  if (!view.connections.length) return '';
  return (
    '<div class="sec" style="max-width:46em">' +
    '<h2 class="display" style="font-size:26px;margin-bottom:6px">Your connections</h2>' +
    '<p class="sub" style="margin-bottom:14px">Yours to read and nobody else’s — not theirs, not ours.</p>' +
    view.connections.map((c) => connectionRow(slug, c)).join('') +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * Outcomes — a closed set of codes, one sentence each
 * ------------------------------------------------------------------ */

const NOTES: Record<string, string> = {
  shared: 'You are on the list now. Only what you picked is visible.',
  unshared: 'You are off the list. Nobody can see what you starred.',
  seen: 'That is what people can see now.',
  noted: 'Noted. They are in your connections, further down.',
  moved: 'That moved while you were looking, so nothing changed.',
  trouble: 'That did not save. Try it once more.',
};

/**
 * The one sentence a redirect is allowed to leave behind. `kept` carries the
 * number of stars the adopt write actually inserted, which is why it is read as
 * a number here and clamped: a count in a URL is only ever as trustworthy as
 * its parse. 02 §6 gives `auth.merged` in the plural only, so the singular is
 * this screen's own sentence — flagged in the report, not invented in the map.
 */
function noteLine(code: string | undefined, n: number): string {
  if (!code) return '';
  if (code === 'kept') {
    if (n < 1) return '';
    const text =
      n === 1
        ? 'Your starred talk came with you.'
        : `${label('auth.merged', 'onstage').split('{n}').join(String(n))}.`;
    return `<p class="chip" style="margin-top:14px">${esc(text)}</p>`;
  }
  const sentence = NOTES[code];
  if (!sentence) return '';
  return `<p class="chip" style="margin-top:14px">${esc(sentence)}</p>`;
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

const back = (slug: string, code?: string, n?: number): string =>
  `/${encodeURIComponent(slug)}/my-schedule` +
  (code ? `?note=${encodeURIComponent(code)}${n ? `&n=${String(n)}` : ''}` : '');

/** The write outcome, or its own word when the write did not land. */
const codeFor = (outcome: 'done' | 'moved' | 'trouble', done: string): string =>
  outcome === 'done' ? done : outcome;

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

    const view = principal ? await socialView(c.env.DB, ev.id, principal.personId) : null;
    const embed = buildEmbed(ev.slug, ag, principal !== null, view?.mine.starred ?? []);

    const head =
      '<h1 class="display">My schedule</h1>' +
      `<p class="sub" style="margin-top:8px">${esc(ev.name)}${ev.tzLabel ? ` · ${esc(ev.tzLabel)}` : ''}</p>`;

    const inner = view
      ? '<div class="wrap" style="padding-top:44px">' +
        head +
        noteLine(c.req.query('note'), Number(c.req.query('n') ?? '0') || 0) +
        `<div class="sec">${serverList(ev.slug, embed, view.mine.starred)}</div>` +
        // An empty list has one next thing, and it is not sharing: the card
        // waits until there is something to share (or until it is already on,
        // so that turning it off is never out of reach).
        (view.mine.starred.length > 0 || view.mine.shareEnabled ? shareCard(ev.slug, view) : '') +
        (view.mine.shareEnabled ? peopleSection(ev.slug, view) : '') +
        connectionsSection(ev.slug, view) +
        `<form id="adopt-stars" method="post" action="/${esc(ev.slug)}/my-schedule/adopt" hidden>` +
        '<input type="hidden" name="sessions" value=""></form>' +
        `<script type="application/json" id="my-schedule-data">${safeJson(embed)}</script>` +
        `<p class="hint" style="margin-top:22px">${esc(
          label('auth.signed_in', 'onstage').split('{name}').join(principal?.name ?? '')
        )} · <a class="link" href="/sign-out">${esc(label('auth.sign_out', 'onstage'))}</a></p>` +
        '</div>'
      : '<div class="wrap" style="padding-top:44px">' +
        head +
        '<div id="my-schedule-root" class="sec">' +
        '<noscript><div class="sec state-out"><h2>Turn on scripts to see your list.</h2>' +
        '<p>Starred sessions are kept in this browser and shown here once scripts run.</p>' +
        `<a class="btn btn-primary" href="/${esc(ev.slug)}/agenda">Browse the agenda →</a></div></noscript>` +
        '</div>' +
        `<script type="application/json" id="my-schedule-data">${safeJson(embed)}</script>` +
        '<p class="hint" style="margin-top:22px">' +
        '<a class="link" href="/sign-in">Signing in keeps this list on every device</a></p>' +
        '<p class="hint" style="margin-top:4px">It is also how you share what you are going to, and see ' +
        'who else is going.</p>' +
        '</div>';

    const body =
      onstageShell(eventNav(ev.slug, '/my-schedule', ev.lifecycle === 'open'), inner) +
      '<script src="/a/stars.js" defer></script>';

    // One person's own page, and once they are signed in it names other people:
    // never held in a shared cache anywhere.
    if (principal) c.header('cache-control', 'private, no-store');

    return c.html(
      page({
        title: `My schedule · ${ev.name}`,
        description: principal
          ? `Your starred sessions at ${ev.name}.`
          : `Your starred sessions at ${ev.name}, kept in this browser.`,
        register: 'onstage',
        body,
      })
    );
  });

  /* -- one click, theirs alone, undone by the same click -- */
  app.post('/:event/my-schedule/star', async (c) => {
    const slug = c.req.param('event');
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);
    const ev = await eventBySlug(c.env.DB, slug);
    if (!ev) return c.notFound();

    const form = await c.req.parseBody();
    const submissionId = String(form['session'] ?? '');
    if (!submissionId) return c.redirect(back(slug, 'moved'), 303);
    const outcome = await setStar(
      c.env.DB,
      principal.personId,
      ev.id,
      submissionId,
      String(form['on'] ?? '1') === '1'
    );
    // A star that landed needs no sentence: the list itself is the answer.
    return c.redirect(outcome === 'done' ? back(slug) : back(slug, outcome), 303);
  });

  /* -- the handshake: what this browser was holding becomes theirs -- */
  app.post('/:event/my-schedule/adopt', async (c) => {
    const slug = c.req.param('event');
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);
    const ev = await eventBySlug(c.env.DB, slug);
    if (!ev) return c.notFound();

    const form = await c.req.parseBody();
    const ids = String(form['sessions'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const { outcome, kept } = await adoptStars(c.env.DB, principal.personId, ev.id, ids);
    if (outcome !== 'done') return c.redirect(back(slug, outcome), 303);
    return c.redirect(kept > 0 ? back(slug, 'kept', kept) : back(slug), 303);
  });

  /* -- the share choice: two passes to go on, one click to come off -- */
  app.post('/:event/my-schedule/share', async (c) => {
    const slug = c.req.param('event');
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);
    const ev = await eventBySlug(c.env.DB, slug);
    if (!ev) return c.notFound();

    const form = await c.req.parseBody();
    const on = String(form['on'] ?? '0') === '1';
    const was = await socialView(c.env.DB, ev.id, principal.personId);
    const outcome = await setSharing(c.env.DB, principal.personId, ev.id, on, {
      work: String(form['work'] ?? '') === '1',
      links: String(form['links'] ?? '') === '1',
      email: String(form['email'] ?? '') === '1',
    });
    // Saying yes again is not the same act as saying yes: while it is already
    // on, this form only changes what people can see.
    const done = on ? (was.mine.shareEnabled ? 'seen' : 'shared') : 'unshared';
    return c.redirect(back(slug, codeFor(outcome, done)), 303);
  });

  /* -- someone to find, noted against the talk you are both going to -- */
  app.post('/:event/my-schedule/connect', async (c) => {
    const slug = c.req.param('event');
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);
    const ev = await eventBySlug(c.env.DB, slug);
    if (!ev) return c.notFound();

    const form = await c.req.parseBody();
    const outcome = await noteConnection(
      c.env.DB,
      principal.personId,
      ev.id,
      String(form['person'] ?? ''),
      String(form['session'] ?? ''),
      String(form['note'] ?? '')
    );
    return c.redirect(back(slug, codeFor(outcome, 'noted')), 303);
  });
}
