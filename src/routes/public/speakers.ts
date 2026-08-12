// The speaker gallery and one speaker's own page. Public, no Principal — a
// stranger's read, same as everything in queries/public.ts.
//
// Persona pass: Dani skims the gallery corridor-fast, looking for who to
// see next; a stranger lands cold, checking that a person carries a real
// history rather than one row behind one talk. Register: Onstage — warm,
// second person absent (this is about a third person, the speaker), dates
// not statuses, sentence case, no exclamation marks.
//
// Two things the gallery gained this pass:
//  - Faces. A headshot is served from /files/{id}; the dashed initials mark
//    stays exactly as it was for everybody who has not sent one, so a page of
//    half-uploaded photographs still reads as one page.
//  - A search (?q=) over names and organisations, applied here over the rows
//    speakersGallery() already returned — no second read, no SQL.
//
// ?embed=1 gives the same grid with the chrome stripped, for a partner site to
// frame. Links out of a frame open the event's own site in a new tab: an
// embedded gallery should never swallow the page hosting it, nor open a whole
// site inside a 600-pixel box.
import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, eventNav, onstageShell } from '../../lib/html';
import { label } from '../../lib/labels';
import {
  eventBySlug,
  speakersGallery,
  speakerPage,
  type EventHome,
  type GallerySpeaker,
  type GallerySession,
  type ElsewhereTalk,
  type PublicState,
  type SpeakerPage,
} from '../../queries/public';

/* ------------------------------------------------------------------ *
 * Small shared bits.
 * ------------------------------------------------------------------ */

// The public decision states a stranger may ever see (queries/public's own
// PUBLIC_STATES) — mapped to their label keys so `label()` gets a real
// LabelKey rather than a template-built string it cannot type-check.
const STATE_LABEL_KEY: Record<PublicState, 'submission.accepted' | 'submission.cancelled'> = {
  accepted: 'submission.accepted',
  cancelled: 'submission.cancelled',
};

const SEARCH_MAX = 80;

/** Where a link goes from here — next door, or out of somebody else's frame. */
type Outbound = { href: (path: string) => string; attrs: string };
const NEXT_DOOR: Outbound = { href: (p) => p, attrs: '' };
function outOfFrame(origin: string): Outbound {
  return { href: (p) => `${origin}${p}`, attrs: ' target="_blank" rel="noopener"' };
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

/** The headshot placeholder: initials in a plain circle, no image request. */
function avatar(initials: string, name: string, size: number): string {
  return (
    `<svg class="av" width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="${esc(name)}">` +
    '<circle cx="20" cy="20" r="20" fill="var(--paper-deep)"/>' +
    '<text x="20" y="21" text-anchor="middle" dominant-baseline="central" font-family="var(--serif)" ' +
    `font-weight="600" font-size="14" fill="var(--ink-soft)">${esc(initials)}</text></svg>`
  );
}

/** The face itself where there is one. Decorative on purpose: the name is
 *  written beside it, and a screen reader should hear it once, not twice. */
function face(p: { name: string; initials: string; headshotFileId: string | null }, size: number): string {
  if (!p.headshotFileId) return avatar(p.initials, p.name, size);
  return (
    `<img class="av" src="/files/${esc(p.headshotFileId)}" alt="" width="${size}" height="${size}" ` +
    `loading="lazy" decoding="async" style="width:${size}px;height:${size}px;object-fit:cover">`
  );
}

/** Job title and organisation, escaped, with only the parts that exist. */
function roleParts(jobTitle: string | null, organisation: string | null): string[] {
  const out: string[] = [];
  if (jobTitle) out.push(esc(jobTitle));
  if (organisation) out.push(esc(organisation));
  return out;
}

/** "{day} {time}, {room}" filled from the label map, in the event's own timezone. */
function placementLine(startsAt: number, timezone: string, roomName: string | null): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(
    startsAt
  );
  const time = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(startsAt);
  let line = label('placement.published', 'onstage').split('{day}').join(day).split('{time}').join(time);
  line = roomName ? line.split('{room}').join(roomName) : line.split(', {room}').join('');
  return line;
}

/* ------------------------------------------------------------------ *
 * Searching — case-folded, every word typed has to turn up somewhere,
 * over the two facts the card in front of you actually shows: who they
 * are and where they work.
 * ------------------------------------------------------------------ */

function tokensOf(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

function matches(p: GallerySpeaker, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const hay = `${p.name} ${p.organisation ?? ''}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/* ------------------------------------------------------------------ *
 * The gallery — GET /:event/speakers
 * ------------------------------------------------------------------ */

function speakerCard(eventSlug: string, p: GallerySpeaker, link: Outbound): string {
  const role = roleParts(p.jobTitle, p.organisation).join('<br>');
  const first = p.sessions[0];
  const more = p.sessions.length > 1 ? ` <span class="sub">+ ${p.sessions.length - 1} more</span>` : '';
  return (
    `<a class="gcard" href="${esc(link.href(`/${eventSlug}/speakers/${p.personId}`))}"${link.attrs}>` +
    face(p, 54) +
    `<div class="gname">${esc(p.name)}</div>` +
    (role ? `<div class="grole">${role}</div>` : '') +
    `<div class="gtalk">${first ? esc(first.title ?? '') : ''}${more}</div>` +
    '</a>'
  );
}

/** Nobody announced yet — never a bare zero, always somewhere to go next. */
function emptyGallery(event: EventHome): string {
  const open = event.lifecycle === 'open';
  const onward = open
    ? `<a class="btn btn-primary" href="/${esc(event.slug)}/cfp">Submit a talk →</a>`
    : `<a class="btn btn-primary" href="/${esc(event.slug)}/agenda">See the agenda →</a>`;
  return (
    '<div class="wrap" style="padding-top:44px"><h1 class="display">Speakers</h1>' +
    '<div class="sec state-out"><h2>Nobody is announced yet.</h2>' +
    `<p>The first names go up here as soon as the program at ${esc(event.name)} takes shape.</p>` +
    `${onward}</div></div>`
  );
}

/** The search box, carrying the frame it sits in so a word typed inside an
 *  embed does not quietly break out of it. */
function searchForm(event: EventHome, q: string, embed: boolean): string {
  const base = `/${event.slug}/speakers`;
  const clear = embed ? `${base}?embed=1` : base;
  return (
    `<form method="get" action="${esc(base)}" class="filters" style="margin:18px 0 4px">` +
    (embed ? '<input type="hidden" name="embed" value="1">' : '') +
    `<input type="text" name="q" value="${esc(q)}" maxlength="${SEARCH_MAX}" autocomplete="off" ` +
    'placeholder="Search names and organisations" aria-label="Search names and organisations" ' +
    'style="flex:1 1 200px;max-width:min(100%,340px)">' +
    '<button class="btn btn-sm" type="submit">Search</button>' +
    (q ? `<a class="link" href="${esc(clear)}">Clear the search</a>` : '') +
    '</form>'
  );
}

function speakersGalleryPage(
  event: EventHome,
  gallery: GallerySpeaker[],
  q: string,
  embed: boolean,
  link: Outbound
): string {
  const nav = eventNav(event.slug, '/speakers', event.lifecycle === 'open');

  if (gallery.length === 0 && !embed) {
    return page({
      title: `Speakers · ${event.name}`,
      description: `Everyone confirmed to speak at ${event.name}.`,
      register: 'onstage',
      body: onstageShell(nav, emptyGallery(event)),
    });
  }

  const tokens = tokensOf(q);
  const shown = gallery.filter((p) => matches(p, tokens));

  const noun = gallery.length === 1 ? '1 speaker' : `${num(gallery.length)} speakers`;
  // Past tense for a lineup that has already been on stage; for one still
  // being built, the honest promise is only that there will be more of it.
  const mastheadLine =
    event.lifecycle === 'happened'
      ? `${noun} at ${event.name}.`
      : `${noun} confirmed at ${event.name}. More to come.`;
  const resultLine =
    q && gallery.length ? `<p class="sub" style="margin:10px 0 0">${esc(`${num(shown.length)} of ${noun}.`)}</p>` : '';

  let grid: string;
  if (!gallery.length) {
    // Only an embed reaches this: the gallery's own empty state is the page
    // above, and it belongs on the event's site, not in somebody's sidebar.
    grid =
      '<div class="sec state-out"><h2>Nobody is announced yet.</h2>' +
      '<p>The first names go up as soon as the program takes shape.</p></div>';
  } else if (!shown.length) {
    // This box only ever reads people. A word that is not a name is almost
    // always a subject, so hand it to the search that reads talk titles, with
    // the word already typed into it.
    grid =
      '<div class="sec state-out"><h2>Nobody by that name.</h2>' +
      '<p>This search reads names and where people work. If you are looking for talks about it, ' +
      'the agenda search reads titles.</p>' +
      `<a class="btn btn-primary" href="${esc(
        link.href(`/${event.slug}/agenda?q=${encodeURIComponent(q)}`)
      )}"${link.attrs}>Look for “${esc(q)}” on the agenda →</a>` +
      `<p class="sub" style="margin-top:12px"><a class="link" href="${esc(
        embed ? `/${event.slug}/speakers?embed=1` : `/${event.slug}/speakers`
      )}">Clear the search</a></p></div>`;
  } else {
    grid = `<div class="sec gal">${shown.map((p) => speakerCard(event.slug, p, link)).join('')}</div>`;
  }

  // One line for the other reader: somebody reading a lineup and wondering
  // whether they could be on it.
  const pitchLine =
    !embed && event.lifecycle === 'open'
      ? '<p class="sub" style="margin-top:6px">Still time to join them — ' +
        `<a class="link" href="/${esc(event.slug)}/cfp">submit a talk</a>.</p>`
      : '';

  const head = embed
    ? ''
    : '<h1 class="display">Speakers</h1>' +
      `<p class="sub" style="margin-top:8px">${esc(mastheadLine)}</p>` +
      pitchLine;

  const wayOut = embed
    ? `<p class="sub" style="margin-top:16px"><a class="link" href="${esc(
        link.href(`/${event.slug}/agenda`)
      )}"${link.attrs}>See the whole program →</a></p>`
    : '';

  const body =
    `<div class="wrap" style="padding-top:${embed ? '8px' : '44px'}">` +
    head +
    (gallery.length ? searchForm(event, q, embed) : '') +
    resultLine +
    grid +
    wayOut +
    '</div>';

  return page({
    title: `Speakers · ${event.name}`,
    description: `Everyone confirmed to speak at ${event.name}.`,
    register: 'onstage',
    body: embed ? `<div class="stage onstage embed"><main>${body}</main></div>` : onstageShell(nav, body),
  });
}

/* ------------------------------------------------------------------ *
 * One speaker — GET /:event/speakers/:personId
 * ------------------------------------------------------------------ */

function sessionRow(event: EventHome, s: GallerySession): string {
  const titleText = esc(s.title ?? '');
  const linkable = Boolean(s.publicSlug) && s.startsAt !== null;
  const titleHtml = linkable
    ? `<a href="/${esc(event.slug)}/s/${esc(s.publicSlug as string)}">${titleText}</a>`
    : titleText;
  const when = s.startsAt !== null ? esc(placementLine(s.startsAt, event.timezone, s.roomName)) : '';
  const cancelledNote = s.cancelled
    ? `<div class="sesh-meta">${esc(label('submission.cancelled', 'onstage'))}</div>`
    : '';
  return (
    '<article class="sesh"><div class="sesh-main">' +
    (when ? `<div class="sesh-when"><span class="time">${when}</span></div>` : '') +
    `<h3${s.cancelled ? ' style="text-decoration:line-through;color:var(--muted)"' : ''}>${titleHtml}</h3>` +
    cancelledNote +
    '</div></article>'
  );
}

/** The sessions block, or one of two honest not-yet states. speakerPage()
 *  cannot tell "accepted here, not yet published" from "not on this
 *  program at all" once the agenda is unpublished — see the report note —
 *  so the unpublished branch is worded to stay true either way. */
function sessionsSection(event: EventHome, firstName: string, sessions: GallerySession[], agendaPublished: boolean): string {
  if (sessions.length > 0) {
    const heading = sessions.length > 1 ? 'Their sessions' : 'Their session';
    return (
      `<div class="sec"><h2 class="display" style="font-size:24px;margin-bottom:12px">${heading}</h2>` +
      `<div class="slot">${sessions.map((s) => sessionRow(event, s)).join('')}</div></div>`
    );
  }
  if (agendaPublished) {
    return (
      `<div class="sec state-out"><h2>${esc(firstName)} is not speaking at ${esc(event.name)}.</h2>` +
      `<a class="btn btn-primary" href="/${esc(event.slug)}/speakers">See who is speaking →</a></div>`
    );
  }
  return (
    '<div class="sec state-out"><h2>Times and rooms are not out yet.</h2>' +
    `<p>Any talk of theirs at ${esc(event.name)} turns up here as soon as they are.</p>` +
    `<a class="btn btn-primary" href="/${esc(event.slug)}/speakers">See who else is speaking →</a></div>`
  );
}

function elsewhereRow(personId: string, t: ElsewhereTalk): string {
  const stateLabel = esc(label(STATE_LABEL_KEY[t.state], 'onstage'));
  const line = `${esc(t.eventName)} ${esc(t.year)} · ${stateLabel}`;
  const linkable = Boolean(t.publicSlug) && t.startsAt !== null;
  const titleHtml = linkable
    ? `<a class="link" href="/${esc(t.eventSlug)}/s/${esc(t.publicSlug as string)}">${esc(t.title)}</a>`
    : esc(t.title);
  return (
    '<div style="padding:10px 0;border-top:1px solid var(--line-soft)">' +
    `<p style="margin:0 0 4px">${titleHtml}</p>` +
    `<p class="sub" style="margin:0"><a class="link" href="/${esc(t.eventSlug)}/speakers/${esc(personId)}">${line}</a></p>` +
    '</div>'
  );
}

function speakerPersonPage(event: EventHome, sp: SpeakerPage): string {
  const nav = eventNav(event.slug, '/speakers', event.lifecycle === 'open');
  const p = sp.person;
  const role = roleParts(p.jobTitle, p.organisation).join(' · ');
  const firstName = p.name.split(' ')[0] || p.name;

  const header =
    `<p class="sub"><a class="link" href="/${esc(event.slug)}/speakers">← All speakers</a></p>` +
    '<div style="display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap;margin-top:16px">' +
    face(p, 96) +
    '<div style="flex:1;min-width:min(100%,280px)">' +
    `<h1 class="display" style="font-size:clamp(28px,4.4vw,40px)">${esc(p.name)}</h1>` +
    (role ? `<p style="margin-top:6px;font-size:17px;color:var(--ink-soft)">${role}</p>` : '') +
    (p.bio ? `<p class="serif" style="margin-top:16px;font-size:18px;line-height:1.62;max-width:44em">${esc(p.bio)}</p>` : '') +
    '</div></div>';

  const sessions = sessionsSection(event, firstName, sp.sessions, sp.agendaPublished);

  const elsewhere = sp.elsewhere.length
    ? '<div class="sec"><h2 class="display" style="font-size:22px;margin-bottom:10px">Their talks</h2>' +
      sp.elsewhere.map((t) => elsewhereRow(p.personId, t)).join('') +
      '</div>'
    : '';

  const body = `<div class="wrap" style="padding-top:36px">${header}${sessions}${elsewhere}</div>`;

  return page({
    title: `${p.name} · ${event.name}`,
    description: `${p.name}'s sessions and speaking history on Fireside.`,
    register: 'onstage',
    body: onstageShell(nav, body),
  });
}

/* ------------------------------------------------------------------ *
 * Routes.
 * ------------------------------------------------------------------ */

export function registerSpeakers(app: Hono<{ Bindings: Env }>): void {
  app.get('/:event/speakers', async (c) => {
    const event = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!event) return c.notFound();
    const gallery = await speakersGallery(c.env.DB, event.id);
    const embed = c.req.query('embed') === '1';
    const q = (c.req.query('q') || '').slice(0, SEARCH_MAX);
    const link = embed ? outOfFrame(new URL(c.req.url).origin) : NEXT_DOOR;
    return c.html(speakersGalleryPage(event, gallery, q, embed, link));
  });

  app.get('/:event/speakers/:personId', async (c) => {
    const event = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!event) return c.notFound();
    const sp = await speakerPage(c.env.DB, event.id, c.req.param('personId'));
    if (!sp) return c.notFound();
    return c.html(speakerPersonPage(event, sp));
  });
}
