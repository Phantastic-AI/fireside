// The speaker gallery and one speaker's own page. Public, no Principal — a
// stranger's read, same as everything in queries/public.ts.
//
// Persona pass: Dani skims the gallery corridor-fast, looking for who to
// see next; the judge lands cold, checking that a person carries a real
// history rather than one row behind one talk. Register: Onstage — warm,
// second person absent (this is about a third person, the speaker), dates
// not statuses, sentence case, no exclamation marks.
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

/** The headshot placeholder: initials in a plain circle, no image request. */
function avatar(initials: string, name: string, size: number): string {
  return (
    `<svg class="av" width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="${esc(name)}">` +
    '<circle cx="20" cy="20" r="20" fill="var(--paper-deep)"/>' +
    '<text x="20" y="21" text-anchor="middle" dominant-baseline="central" font-family="var(--serif)" ' +
    `font-weight="600" font-size="14" fill="var(--ink-soft)">${esc(initials)}</text></svg>`
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
 * The gallery — GET /:event/speakers
 * ------------------------------------------------------------------ */

function speakerCard(eventSlug: string, p: GallerySpeaker): string {
  const role = roleParts(p.jobTitle, p.organisation).join('<br>');
  const first = p.sessions[0];
  const more = p.sessions.length > 1 ? ` <span class="sub">+ ${p.sessions.length - 1} more</span>` : '';
  return (
    `<a class="gcard" href="/${esc(eventSlug)}/speakers/${esc(p.personId)}">` +
    avatar(p.initials, p.name, 54) +
    `<div class="gname">${esc(p.name)}</div>` +
    (role ? `<div class="grole">${role}</div>` : '') +
    `<div class="gtalk">${first ? esc(first.title ?? '') : ''}${more}</div>` +
    '</a>'
  );
}

/** Call open, nobody accepted yet — never a bare zero, always a door onward. */
function emptyGallery(event: EventHome): string {
  return (
    '<div class="wrap" style="padding-top:44px"><h1 class="display">Speakers</h1>' +
    '<div class="sec state-out"><h2>The program is being decided now.</h2>' +
    `<p>Nobody has been announced at ${esc(event.name)} yet. The call for speakers is where the program starts.</p>` +
    `<a class="btn btn-primary" href="/${esc(event.slug)}/cfp">See the call for speakers →</a></div></div>`
  );
}

function speakersGalleryPage(event: EventHome, gallery: GallerySpeaker[]): string {
  const nav = eventNav(event.slug, '/speakers', event.lifecycle === 'open');
  const body =
    gallery.length === 0
      ? emptyGallery(event)
      : (() => {
          const noun = gallery.length === 1 ? '1 speaker' : `${gallery.length.toLocaleString('en-US')} speakers`;
          const more = event.lifecycle === 'happened' ? '' : ' More as decisions go out.';
          return (
            '<div class="wrap" style="padding-top:44px"><h1 class="display">Speakers</h1>' +
            `<p class="sub" style="margin-top:8px">${noun} confirmed at ${esc(event.name)}.${more}</p>` +
            `<div class="sec gal">${gallery.map((p) => speakerCard(event.slug, p)).join('')}</div></div>`
          );
        })();

  return page({
    title: `Speakers · ${event.name}`,
    description: `Everyone confirmed to speak at ${event.name}.`,
    register: 'onstage',
    body: onstageShell(nav, body),
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
      `<div class="sec state-out"><h2>Not speaking at ${esc(event.name)}.</h2>` +
      `<p>${esc(firstName)} doesn't have a talk on this program.</p>` +
      `<a class="btn btn-primary" href="/${esc(event.slug)}/speakers">See who is speaking →</a></div>`
    );
  }
  return (
    '<div class="sec state-out"><h2>The schedule isn\'t out yet.</h2>' +
    `<p>Times and rooms for ${esc(event.name)} haven't been published. Once they are, any sessions here will show up on this page.</p>` +
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
    avatar(p.initials, p.name, 96) +
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
    return c.html(speakersGalleryPage(event, gallery));
  });

  app.get('/:event/speakers/:personId', async (c) => {
    const event = await eventBySlug(c.env.DB, c.req.param('event'));
    if (!event) return c.notFound();
    const sp = await speakerPage(c.env.DB, event.id, c.req.param('personId'));
    if (!sp) return c.notFound();
    return c.html(speakerPersonPage(event, sp));
  });
}
