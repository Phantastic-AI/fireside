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
// Scope notes (see report to the calling agent for the full list):
//  - No star/schedule control anywhere on these two screens, embed or not.
//    Starring is a different parcel; rendering one here would either fight
//    that parcel's markup or 404 on JS it hasn't shipped yet.
//  - Agenda cards render speaker names only, no avatar stack: AgendaSession's
//    SpeakerRef carries no headshotFileId, only the session page's
//    PublicSpeaker does.
//  - The session page drops the prototype's "Also on this program" rail —
//    it needs a query this parcel's task did not name.
//  - No embed-code-copy control — that is client script the prototype ships
//    and this SSR page does not.
//  - No .ics link anywhere — no route exists for it yet.
import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, onstageShell, eventNav } from '../../lib/html';
import { label, type LabelKey } from '../../lib/labels';
import {
  agenda,
  eventBySlug,
  sessionBySlug,
  type Agenda,
  type AgendaSession,
  type EventHome,
  type PublicSpeaker,
} from '../../queries/public';

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

function dateLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(
    dateFromKey(iso)
  );
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

function durationLabel(minutes: number): string {
  return minutes >= 90 && minutes % 60 === 0 ? `${minutes / 60} hr` : `${minutes} min`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n.toLocaleString('en-US')} ${many}`;
}

function joinParts(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(' · ');
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

const FORMAT_KEY: Record<string, LabelKey> = {
  talk: 'format.talk',
  workshop: 'format.workshop',
  panel: 'format.panel',
  lightning: 'format.lightning',
};

function formatLabel(fmt: string): string {
  const key = FORMAT_KEY[fmt];
  return key ? label(key, 'onstage') : fmt;
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
 * Avatars: generated, deterministic, no network request — the same
 * promise the prototype makes. Session-page speakers only; see report
 * for why agenda cards render no avatar stack.
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

/* ------------------------------------------------------------------ *
 * URL building — day/track/embed query state, preserved across links.
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

/* ------------------------------------------------------------------ *
 * Session card — mirrors the prototype's seshCard, minus the star
 * button (a different parcel) and the avatar stack (see report).
 * ------------------------------------------------------------------ */

function seshCard(slug: string, timezone: string, s: AgendaSession): string {
  const href = s.publicSlug ? `/${esc(slug)}/s/${esc(s.publicSlug)}` : null;
  const strike = s.cancelled ? ' style="text-decoration:line-through;text-decoration-color:var(--muted-2)"' : '';
  const titleHtml = href
    ? `<a href="${href}"${strike}>${esc(s.title)}</a>`
    : `<span${strike}>${esc(s.title)}</span>`;
  const names = s.speakers.map((p) => p.name);
  return (
    `<article class="sesh" style="${s.track ? trackStyle(s.track.colour) : ''}">` +
    '<div class="sesh-main">' +
    `<div class="sesh-when"><span class="time">${esc(timeOfDay(s.startsAt, timezone))}</span>` +
    (s.roomName ? `<span class="room">${esc(s.roomName)}</span>` : '') +
    '</div>' +
    `<h3>${titleHtml}</h3>` +
    (names.length ? `<div class="sesh-by"><span>${byline(names)}</span></div>` : '') +
    `<div class="sesh-meta">${trackBadge(s.track)}<span>${esc(formatLabel(s.format))} · ${esc(durationLabel(s.minutes))}</span>` +
    (s.cancelled ? `<span class="sub">· ${esc(label('submission.cancelled', 'onstage'))}</span>` : '') +
    '</div></div></article>'
  );
}

/* ------------------------------------------------------------------ *
 * The published agenda body: header, day tabs, track legend, the
 * day-by-day list. Room lanes read as consecutive same-time cards,
 * each naming its own room — the prototype never used a literal
 * multi-column grid either.
 * ------------------------------------------------------------------ */

function agendaBody(
  event: EventHome,
  ag: Agenda,
  params: { day: string; track: string; embed: boolean },
  slug: string
): string {
  const allSessions = ag.days.flatMap((d) => d.slots.flatMap((sl) => sl.sessions));

  const trackList: { slug: string; name: string; colour: string }[] = [];
  const seenTracks = new Set<string>();
  for (const s of allSessions) {
    if (s.track && !seenTracks.has(s.track.slug)) {
      seenTracks.add(s.track.slug);
      trackList.push(s.track);
    }
  }
  const roomNames = new Set(allSessions.map((s) => s.roomName).filter((x): x is string => !!x));
  const speakerIds = new Set(allSessions.flatMap((s) => s.speakers.map((sp) => sp.personId)));

  const { day: dayParam, track: trackParam, embed } = params;

  const hereUrl = (over: { day?: string | null; track?: string | null }) =>
    withQuery(`/${slug}/agenda`, {
      day: over.day !== undefined ? over.day : dayParam || null,
      track: over.track !== undefined ? over.track : trackParam || null,
      embed: embed ? '1' : null,
    });

  const dayChips =
    `<a class="fchip" href="${hereUrl({ day: null })}" aria-pressed="${!dayParam}">All days</a>` +
    ag.days
      .map(
        (d) =>
          `<a class="fchip" href="${hereUrl({ day: d.day })}" aria-pressed="${dayParam === d.day}">${esc(weekdayDate(d.day, 'short'))}</a>`
      )
      .join('');

  const trackChips = trackList.length
    ? `<a class="fchip" href="${hereUrl({ track: null })}" aria-pressed="${!trackParam}">All tracks</a>` +
      trackList
        .map(
          (t) =>
            `<a class="fchip tkchip" style="${trackStyle(t.colour)}" href="${hereUrl({ track: t.slug })}" aria-pressed="${trackParam === t.slug}">${esc(t.name)}</a>`
        )
        .join('')
    : '';

  let listHtml = '';
  let anyMatched = false;
  for (const d of ag.days) {
    const inDay = d.slots
      .flatMap((sl) => sl.sessions)
      .filter((s) => (!trackParam || s.track?.slug === trackParam) && (!dayParam || dayParam === d.day));
    if (!inDay.length) continue;
    anyMatched = true;
    listHtml +=
      `<div class="dayhead">${esc(weekdayDate(d.day, 'short'))} · ${esc(plural(inDay.length, 'session', 'sessions'))}</div>` +
      `<div class="slot">${inDay.map((s) => seshCard(slug, ag.timezone, s)).join('')}</div>`;
  }

  if (!allSessions.length) {
    listHtml =
      '<div class="state-out" style="margin-top:26px"><h2>Nothing on the agenda yet.</h2>' +
      '<p>Speakers already confirmed are on the speakers page while the schedule comes together.</p>' +
      `<a class="btn btn-primary" href="/${esc(slug)}/speakers">See who's speaking →</a></div>`;
  } else if (!anyMatched) {
    listHtml =
      '<div class="state-out" style="margin-top:26px"><h2>Nothing here with those filters.</h2>' +
      '<p>The other days and tracks still have plenty.</p>' +
      `<a class="btn btn-primary" href="${hereUrl({ day: null, track: null })}">Show the whole agenda →</a></div>`;
  }

  const headLine = joinParts([
    dateRangeLabel(event.startsOn, event.endsOn),
    event.venueName,
    event.tzLabel ? `All times ${event.tzLabel}` : null,
  ]);
  const countsLine = roomNames.size
    ? `${plural(allSessions.length, 'session', 'sessions')} across ${plural(roomNames.size, 'room', 'rooms')} · ${plural(speakerIds.size, 'speaker', 'speakers')}`
    : `${plural(allSessions.length, 'session', 'sessions')} · ${plural(speakerIds.size, 'speaker', 'speakers')}`;

  const head =
    `<h1 class="display">${esc(event.name)}</h1>` +
    `<p class="sub" style="margin-top:8px">${esc(headLine)}</p>` +
    (allSessions.length ? `<p class="sub">${esc(countsLine)}</p>` : '') +
    `<div class="filters scrollx daybar">${dayChips}</div>` +
    (trackChips ? `<div class="filters scrollx daybar">${trackChips}</div>` : '');

  // Embed mirrors the prototype exactly: day tabs are dropped, only the
  // track legend survives, because an embedded widget is already scoped
  // by whatever page it sits on.
  const embedBar = embed && trackChips ? `<div class="filters scrollx daybar">${trackChips}</div>` : '';

  return (
    `<div class="wrap" style="padding-top:${embed ? '8px' : '44px'}">` +
    (embed ? embedBar : head) +
    listHtml +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * One speaker, on the session page: avatar, name, title/org, bio.
 * ------------------------------------------------------------------ */

function speakerBlock(slug: string, p: PublicSpeaker): string {
  const titleOrg = joinParts([p.jobTitle, p.organisation]);
  const href = `/${esc(slug)}/speakers/${esc(p.personId)}`;
  return (
    '<div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-bottom:20px">' +
    `<a href="${href}" tabindex="-1" aria-hidden="true">${avatarSvg(p.name, p.initials, 56, p.headshotFileId !== null)}</a>` +
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
    const ag = await agenda(db, event.id);
    if (!ag) return c.notFound();

    const embed = c.req.query('embed') === '1';
    const dayParam = c.req.query('day') || '';
    const trackParam = c.req.query('track') || '';
    const nav = eventNav(slug, '/agenda', event.lifecycle === 'open');

    let inner: string;
    if (!ag.published) {
      const decideClause = event.decideBy
        ? `Decisions go out by ${dateLabel(event.decideBy)}.`
        : 'Decisions are still being made.';
      const headLine = joinParts([
        dateRangeLabel(event.startsOn, event.endsOn),
        event.venueName,
        event.tzLabel ? `All times ${event.tzLabel}` : null,
      ]);
      inner =
        `<div class="wrap" style="padding-top:${embed ? '8px' : '44px'}">` +
        (embed
          ? ''
          : `<h1 class="display">${esc(event.name)}</h1>` +
            `<p class="sub" style="margin-top:8px">${esc(headLine)}</p>`) +
        '<div class="sec state-out"><h2>The program is still being decided.</h2>' +
        `<p>${esc(decideClause)} Speakers already confirmed are on the speakers page.</p>` +
        `<a class="btn btn-primary" href="/${esc(slug)}/speakers">See who's speaking →</a></div>` +
        '</div>';
    } else {
      inner = agendaBody(event, ag, { day: dayParam, track: trackParam, embed }, slug);
    }

    const body = embed ? `<div class="stage onstage embed"><main>${inner}</main></div>` : onstageShell(nav, inner);

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
      `${weekdayDate(session.day, 'long')}, ${timeOfDay(session.startsAt, session.timezone)}`,
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
      '</div>' +
      (recordingCta ? `<div class="card card-pad" style="min-width:210px">${recordingCta}</div>` : '') +
      '</div>' +
      abstractHtml +
      (speakerBlocks
        ? `<div class="sec"><h2 class="display" style="font-size:24px;margin-bottom:14px">${session.speakers.length > 1 ? 'The speakers' : 'The speaker'}</h2>${speakerBlocks}</div>`
        : '') +
      '</div>';

    const body = embed ? `<div class="stage onstage embed"><main>${inner}</main></div>` : onstageShell(nav, inner);

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
