// S-17 — the green room (Marcus's screen) — and S-18 — the slides board.
//
// Marcus Oyelaran is a volunteer with a lanyard, a phone, and twenty-eight
// minutes to doors. He does not hold the organizer credential and never
// will; all of the crew holds phones. His whole question is "who's next,
// and are their slides in?" — and the answer has to survive being read
// standing up, on one bar of venue wifi. That is why S-17 is mounted twice:
// once behind a login for the organizer, and once behind a share token
// (R-4) for everyone who is not one. Same run of show, same markup, two
// doors in.
//
// Laws this file is built on:
//   R-4    — the token route trades a Principal for event.green_room_nonce.
//            Rotating the nonce (Settings, a sibling parcel) is the entire
//            revocation model; this file never mints or rotates it, only
//            reads it. queries/greenroom-token.ts's eventByGreenRoomNonce is
//            the one query in this build that authenticates by token.
//   D-025  — every heading parses cold.
//   D-027  — nothing here knows the software is new.
//   "exactly one CTA out" (11-hats.md) — the only actionable control on a
//   session card is the tel: link. Nothing else on S-17 is clickable, on
//   purpose: a runner who has to make a second decision on one bar of
//   signal is a runner the page has failed.
//
// The read is queries/admin.ts `adminEvents` (to resolve and scope the
// slug) and `greenRoom` (the day's run of show — token-scoped by design, so
// this file supplies the Principal check greenRoom() itself does not: see
// its own doc comment). No writes: nothing on either screen changes state.
//
// Gaps routed around — see the report to the calling agent for the full
// list; the two that shape the markup most:
//   - GreenRoomSession carries no headshot fact, so no avatar renders on a
//     session card (the DTO was not built to answer "does this person have
//     a photo").
//   - GreenRoomSession's task read has no person_id, so "who was asked" for
//     an absent deck is answered with the session's own speaker list rather
//     than the task's actual assignee — the two are usually the same person
//     but the DTO cannot say so for certain.
import type { Hono } from 'hono';
import type { Env } from '../../index';
import { esc, page, backstageShell, deniedPage } from '../../lib/html';
import { label, FORMAT_KEY, type LabelKey } from '../../lib/labels';
import {
  adminEvents,
  greenRoom,
  requireScope,
  READ_ROLES,
  EDIT_ROLES,
  ScopeError,
  type AdminEvent,
  type GreenRoom,
  type GreenRoomSession,
  type SlidesStatus,
} from '../../queries/admin';
import { eventDayKey } from '../../queries/public';
import { principalFromCookie, type Principal } from '../../workflows/account';
import { eventByGreenRoomNonce } from '../../queries/greenroom-token';

/* ------------------------------------------------------------------ *
 * Small words and numbers — duplicated locally rather than added to a
 * shared lib, matching this build's per-file convention (see agenda.ts,
 * outbox.ts).
 * ------------------------------------------------------------------ */

const num = (x: number): string => x.toLocaleString('en-US');
const plural = (x: number, one: string, many: string): string =>
  x === 1 ? `1 ${one}` : `${num(x)} ${many}`;

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

/** "A", "A with B", "A with B and C" — the byline every screen in this
 *  product writes the same way (agenda.ts's onstage version, in words). */
function byline(names: string[]): string {
  const n = names.map((x) => esc(x));
  if (n.length === 0) return '';
  if (n.length === 1) return n[0]!;
  if (n.length === 2) return `${n[0]} with ${n[1]}`;
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/** tel: hrefs tolerate punctuation, but a clean digit string is honest
 *  regardless of how the seed or a speaker typed their number in. */
function telHref(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

function formatLabel(fmt: string): string {
  const key: LabelKey | undefined = FORMAT_KEY[fmt];
  return key ? label(key, 'backstage') : fmt;
}

function durationLabel(minutes: number): string {
  return minutes >= 90 && minutes % 60 === 0 ? `${minutes / 60} hr` : `${minutes} min`;
}

const PHONE_ICON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M6.5 3h3l1.5 4-2 1.4a12 12 0 006.6 6.6l1.4-2 4 1.5v3a2 2 0 01-2.2 2A17 17 0 014.5 5.2 2 2 0 016.5 3z"/></svg>';

/* ------------------------------------------------------------------ *
 * Dates, on the event's own clock. day keys are "YYYY-MM-DD" wall dates
 * (queries/public.ts's eventDayKey) — formatted in UTC so a short label
 * never re-applies the timezone and shifts by a day (agenda.ts's pattern).
 * ------------------------------------------------------------------ */

function dateFromKey(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function dayShort(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(dateFromKey(iso));
}

function dayLong(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  }).format(dateFromKey(iso));
}

function timeOfDay(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

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
 * Slides: the file.* labels already carry the whole chip string,
 * including the due date on the overdue cell — see lib/labels.ts §1.8.
 * The board's own Detail column only adds what the chip does not: who,
 * and (for a deck not yet overdue) when.
 * ------------------------------------------------------------------ */

function slidesChip(status: SlidesStatus, dueOn: string | null, todayKey: string): string {
  if (status === 'present') {
    return `<span class="chip s-accepted">${esc(label('file.present', 'backstage'))}</span>`;
  }
  if (status === 'not_requested') {
    return `<span class="chip plain">${esc(label('file.not_requested', 'backstage'))}</span>`;
  }
  const overdue = dueOn !== null && dueOn < todayKey;
  if (overdue) {
    const text = label('file.absent_overdue', 'backstage').replace('{date}', dayShort(dueOn!));
    return `<span class="chip warn">${esc(text)}</span>`;
  }
  return `<span class="chip s-undecided">${esc(label('file.absent', 'backstage'))}</span>`;
}

/** Only fires for a deck that is absent and not yet overdue — an overdue
 *  one already carries its date inside the chip. */
function slidesDueDetail(status: SlidesStatus, dueOn: string | null, todayKey: string): string {
  if (status !== 'absent' || dueOn === null || dueOn < todayKey) return '';
  return `due ${dayShort(dueOn)}`;
}

/* ------------------------------------------------------------------ *
 * Access: resolving an :eventSlug the same way every backstage screen
 * does — adminEvents() already scopes to what this principal may see, so
 * "not in that list" and "not yours" are one and the same refusal.
 * ------------------------------------------------------------------ */

async function eventFor(
  db: D1Database,
  principal: Principal,
  slug: string
): Promise<AdminEvent | undefined> {
  const events = await adminEvents(db, principal);
  return events.find((e) => e.slug === slug);
}

function hasScope(principal: Principal, eventId: string, allowed: readonly string[]): boolean {
  try {
    requireScope(principal, eventId, allowed);
    return true;
  } catch {
    return false;
  }
}

/**
 * The share link's raw material. queries/admin.ts's AdminEvent carries no
 * green_room_nonce — its DTO was shaped for the events index, not this
 * screen — and this build's file discipline does not let this parcel add
 * one there. This is the narrow, own-file exception: a single column, on
 * the event this principal has already been proven to hold, read nowhere
 * else in this file. It is called only after an EDIT_ROLES check.
 */
async function greenRoomNonceFor(db: D1Database, eventId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT green_room_nonce FROM event WHERE id = ?')
    .bind(eventId)
    .first<{ green_room_nonce: string | null }>();
  return row?.green_room_nonce ?? null;
}

/* ------------------------------------------------------------------ *
 * The session card — the one piece of markup S-17 shares between its
 * logged-in door and its token door.
 * ------------------------------------------------------------------ */

function sessionCard(s: GreenRoomSession, todayKey: string): string {
  const strike = s.cancelled
    ? ' style="text-decoration:line-through;text-decoration-color:var(--muted-2)"'
    : '';
  const names = s.speakers.map((p) => p.name);
  const nameLine = byline(names) || 'No speaker listed';
  const cancelledNote = s.cancelled
    ? `<p class="sub" style="margin:-4px 0 10px">${esc(label('submission.cancelled', 'backstage'))}</p>`
    : '';
  const telRows = s.speakers
    .filter((sp) => sp.phone && sp.phone.trim() !== '')
    .map((sp) => {
      const telText = names.length > 1 ? `${esc(sp.name)} · ${esc(sp.phone!)}` : esc(sp.phone!);
      return `<a class="gr-tel" href="tel:${esc(telHref(sp.phone!))}">${PHONE_ICON}${telText}</a>`;
    })
    .join('');

  return (
    '<div class="gr-card"><div class="gr-body">' +
    `<div class="gr-name">${nameLine}</div>` +
    cancelledNote +
    telRows +
    `<div class="gr-talk"${strike}>${esc(s.title)}</div>` +
    `<div class="gr-meta">${esc(formatLabel(s.format))} · ${esc(durationLabel(s.minutes))}</div>` +
    `<div class="gr-file"><b style="font-size:13.5px">Slides:</b> ${slidesChip(s.slides, s.slidesDueOn, todayKey)}</div>` +
    '</div></div>'
  );
}

/** Groups consecutive sessions by (time, room) into one .gr-when block —
 *  mirrors screenGreenRoom's own grouping exactly. The very first slot on
 *  the page carries "Up first", a mobile-only chip (backstage.css). */
function sessionCards(sessions: GreenRoomSession[], timezone: string, todayKey: string): string {
  let html = '';
  let lastKey = '';
  let first = true;
  for (const s of sessions) {
    const key = `${s.startsAt}|${s.roomName ?? ''}`;
    if (key !== lastKey) {
      if (lastKey) html += '</div>';
      html +=
        '<div class="gr-slot"><div class="gr-when">' +
        `<span class="t">${esc(timeOfDay(s.startsAt, timezone))}</span>` +
        `<span class="r">${esc(s.roomName ?? 'No room set')}</span>` +
        (first ? '<span class="upnext">Up first</span>' : '') +
        '</div>';
      lastKey = key;
      first = false;
    }
    html += sessionCard(s, todayKey);
  }
  return html ? `${html}</div>` : '';
}

/* ------------------------------------------------------------------ *
 * S-17, door one: /admin/:eventSlug/green-room
 * ------------------------------------------------------------------ */

function dayTabs(basePath: string, days: string[], current: string): string {
  return days
    .map(
      (d) =>
        `<a class="fchip" href="${esc(withQuery(basePath, { day: d }))}" aria-pressed="${d === current}">${esc(dayShort(d))}</a>`
    )
    .join('');
}

function shareRow(slug: string, nonce: string | null): string {
  if (!nonce) {
    return (
      '<div class="sec standing"><p style="margin:0">No public link yet. ' +
      `<a class="link" href="/admin/${encodeURIComponent(slug)}/settings">Create one in settings →</a></p></div>`
    );
  }
  const href = `/gr/${esc(nonce)}`;
  return (
    '<div class="sec standing">' +
    `<p style="margin:0">The public sheet: <a class="link" href="${href}">${href}</a></p>` +
    '<p class="hint" style="margin-top:6px">Anyone with this link sees this page. Rotate it in Settings.</p>' +
    '</div>'
  );
}

function adminGreenRoomPage(
  principal: Principal,
  ev: AdminEvent,
  gr: GreenRoom,
  nonce: string | null
): string {
  const slug = ev.slug;
  const tzLabel = gr.tzLabel ?? gr.timezone;
  const todayKey = eventDayKey(Date.now(), gr.timezone);
  const speakerCount = new Set(gr.sessions.flatMap((s) => s.speakers.map((sp) => sp.personId))).size;

  const head =
    '<div style="padding:24px 0 0"><h1 class="display">Green room</h1>' +
    '<p class="counts">' +
    (gr.sessions.length
      ? `${esc(plural(gr.sessions.length, 'talk', 'talks'))} on ${esc(dayLong(gr.day))}` +
        `<span class="sep">·</span>${esc(plural(speakerCount, 'speaker', 'speakers'))}`
      : '<b>Nothing scheduled</b>') +
    `<span class="sep">·</span>${esc(tzLabel)}</p>` +
    `<div class="filters daybar" style="margin-top:12px">${dayTabs(`/admin/${encodeURIComponent(slug)}/green-room`, gr.days, gr.day)}</div>` +
    '</div>';

  const share = hasScope(principal, ev.id, EDIT_ROLES) ? shareRow(slug, nonce) : '';

  const body = gr.sessions.length
    ? `<div class="sec" style="max-width:640px">${sessionCards(gr.sessions, gr.timezone, todayKey)}` +
      '<p class="hint">This sheet is built to be read standing up, on a phone, in a corridor.</p></div>'
    : '<div class="sec state-out">' +
      `<h2>Nothing scheduled on ${esc(dayLong(gr.day))} yet.</h2>` +
      '<p>Talks appear here the moment they get a time and a room.</p>' +
      `<a class="btn btn-primary" href="/admin/${encodeURIComponent(slug)}/agenda">Open the agenda builder →</a></div>`;

  return page({
    title: `Green room · ${ev.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: slug,
      eventName: ev.name,
      here: '/green-room',
      who: `${principal.name} · ${cap(ev.standing)}`,
      whoInitials: initialsOf(principal.name),
      tzLabel: ev.tzLabel ?? ev.timezone,
      body: head + share + body,
    }),
  });
}

/* ------------------------------------------------------------------ *
 * S-17, door two: /gr/:nonce — no sign-in, no nav chrome, just the day.
 * The lightest page in the product, by law: the same session-card markup
 * as the admin door, no day switcher, no other link on the page at all.
 * ------------------------------------------------------------------ */

function publicGreenRoomPage(ev: { name: string }, gr: GreenRoom): string {
  const tzLabel = gr.tzLabel ?? gr.timezone;
  const todayKey = eventDayKey(Date.now(), gr.timezone);

  const head =
    '<div style="padding:20px 0 0">' +
    '<h1 class="display" style="font-size:26px">Green room</h1>' +
    `<p class="sub" style="margin-top:2px">${esc(ev.name)}</p>` +
    '<p class="counts">' +
    (gr.sessions.length
      ? `${esc(dayLong(gr.day))}`
      : `<b>Nothing scheduled on ${esc(dayLong(gr.day))}</b>`) +
    `<span class="sep">·</span>${esc(tzLabel)}</p></div>`;

  const body = gr.sessions.length
    ? `<div class="sec" style="max-width:640px">${sessionCards(gr.sessions, gr.timezone, todayKey)}</div>`
    : '<div class="sec state-out"><h2>Nothing scheduled yet.</h2>' +
      '<p>Check back closer to the day.</p></div>';

  return page({
    title: `Green room · ${ev.name}`,
    register: 'backstage',
    body: '<div class="stage backstage"><main><div class="wrap" style="padding-bottom:40px">' + head + body + '</div></main></div>',
  });
}

/* ------------------------------------------------------------------ *
 * S-18: /admin/:eventSlug/slides
 *
 * greenRoom() answers one day at a time (S-17's own shape); the slides
 * board needs every accepted session across the whole event, so this
 * calls it once per day the event actually has something on. Small,
 * correct, and cheap at the scale one conference runs at — the
 * alternative was a second query this parcel is not scoped to add.
 * ------------------------------------------------------------------ */

async function allAcceptedSessions(
  db: D1Database,
  eventId: string
): Promise<{ event: GreenRoom; sessions: GreenRoomSession[] } | null> {
  const probe = await greenRoom(db, eventId);
  if (!probe) return null;
  const perDay = await Promise.all(probe.days.map((d) => greenRoom(db, eventId, d)));
  const sessions = perDay
    .flatMap((g) => g?.sessions ?? [])
    .filter((s) => s.state === 'accepted');
  return { event: probe, sessions };
}

function slidesRow(
  s: GreenRoomSession,
  day: string,
  timezone: string,
  todayKey: string
): string {
  const strike = s.cancelled
    ? ' style="text-decoration:line-through;text-decoration-color:var(--muted-2)"'
    : '';
  const names = byline(s.speakers.map((p) => p.name));
  const detail = slidesDueDetail(s.slides, s.slidesDueOn, todayKey);
  return (
    '<tr>' +
    `<td class="num" style="white-space:nowrap"><b>${esc(timeOfDay(s.startsAt, timezone))}</b><br>` +
    `<span class="t-sub">${esc(dayShort(day))}</span></td>` +
    `<td style="white-space:nowrap">${esc(s.roomName ?? 'No room set')}</td>` +
    `<td><span class="t-name"${strike}>${esc(s.title)}</span><br>` +
    `<span class="t-sub">${names || 'No speaker listed'} · ${esc(formatLabel(s.format))} · ${esc(durationLabel(s.minutes))}</span></td>` +
    `<td>${slidesChip(s.slides, s.slidesDueOn, todayKey)}</td>` +
    `<td><span class="t-sub">${esc(detail)}</span></td>` +
    '</tr>'
  );
}

function slidesPage(
  principal: Principal,
  ev: AdminEvent,
  gr: GreenRoom,
  rows: { s: GreenRoomSession; day: string }[],
  filters: { day: string; room: string },
  allDays: string[],
  allRooms: string[]
): string {
  const slug = ev.slug;
  const tzLabel = gr.tzLabel ?? gr.timezone;
  const todayKey = eventDayKey(Date.now(), gr.timezone);
  const total = rows.length;
  const inCount = rows.filter((r) => r.s.slides === 'present').length;
  const pct = total ? Math.round((inCount / total) * 100) : 0;

  const basePath = `/admin/${encodeURIComponent(slug)}/slides`;
  const dayChips =
    `<a class="fchip" href="${esc(withQuery(basePath, { day: null, room: filters.room || null }))}" aria-pressed="${!filters.day}">Every day</a>` +
    allDays
      .map(
        (d) =>
          `<a class="fchip" href="${esc(withQuery(basePath, { day: d, room: filters.room || null }))}" aria-pressed="${filters.day === d}">${esc(dayShort(d))}</a>`
      )
      .join('');
  const roomChips = allRooms.length
    ? `<a class="fchip" href="${esc(withQuery(basePath, { day: filters.day || null, room: null }))}" aria-pressed="${!filters.room}">Every room</a>` +
      allRooms
        .map(
          (r) =>
            `<a class="fchip" href="${esc(withQuery(basePath, { day: filters.day || null, room: r }))}" aria-pressed="${filters.room === r}">${esc(r)}</a>`
        )
        .join('')
    : '';

  const head =
    '<div style="padding:26px 0 0"><h1 class="display">Slides</h1>' +
    '<p class="counts">' +
    (total
      ? `<b>${esc(num(inCount))} of ${esc(num(total))} in</b> (${pct}%)`
      : '<b>Nothing accepted yet</b>') +
    `<span class="sep">·</span>${esc(tzLabel)}</p></div>` +
    `<div class="filters scrollx daybar" style="margin-top:14px">${dayChips}</div>` +
    (roomChips ? `<div class="filters scrollx daybar">${roomChips}</div>` : '') +
    (total && inCount === total
      ? '<div class="sec attn" style="background:var(--go-wash);border-color:#CBE0D1">' +
        `<div><div class="lab">Every deck is in. ${esc(num(inCount))} of ${esc(num(total))}.</div></div></div>`
      : '');

  let body: string;
  if (total === 0) {
    body =
      '<div class="sec state-out"><h2>Nothing accepted yet.</h2>' +
      '<p>Sessions show up here once they are accepted and placed on the agenda.</p>' +
      `<a class="btn btn-primary" href="/admin/${encodeURIComponent(slug)}/submissions">Go to proposals →</a></div>`;
  } else if (rows.length === 0) {
    body =
      '<div class="sec state-out"><h2>Nothing here with those filters.</h2>' +
      `<a class="btn btn-primary" href="${basePath}">Show every session →</a></div>`;
  } else {
    body =
      '<div class="tablewrap" style="margin-top:16px"><table class="t"><thead><tr>' +
      '<th>When</th><th>Room</th><th>Session</th><th>Slides</th><th>Detail</th></tr></thead><tbody>' +
      rows.map((r) => slidesRow(r.s, r.day, gr.timezone, todayKey)).join('') +
      '</tbody></table></div>';
  }

  return page({
    title: `Slides · ${ev.name}`,
    register: 'backstage',
    body: backstageShell({
      eventSlug: slug,
      eventName: ev.name,
      here: '/slides',
      who: `${principal.name} · ${cap(ev.standing)}`,
      whoInitials: initialsOf(principal.name),
      tzLabel: ev.tzLabel ?? ev.timezone,
      body: head + body,
    }),
  });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

export function registerGreenRoomAdmin(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/:eventSlug/green-room', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');

    const slug = c.req.param('eventSlug');
    try {
      const ev = await eventFor(c.env.DB, principal, slug);
      if (!ev) return c.html(deniedPage(), 403);
      requireScope(principal, ev.id, READ_ROLES);

      const day = c.req.query('day') || undefined;
      const gr = await greenRoom(c.env.DB, ev.id, day);
      if (!gr) return c.notFound();

      const nonce = hasScope(principal, ev.id, EDIT_ROLES)
        ? await greenRoomNonceFor(c.env.DB, ev.id)
        : null;

      return c.html(adminGreenRoomPage(principal, ev, gr, nonce));
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.get('/admin/:eventSlug/slides', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');

    const slug = c.req.param('eventSlug');
    try {
      const ev = await eventFor(c.env.DB, principal, slug);
      if (!ev) return c.html(deniedPage(), 403);
      requireScope(principal, ev.id, READ_ROLES);

      const all = await allAcceptedSessions(c.env.DB, ev.id);
      if (!all) return c.notFound();

      const withDay = all.sessions.map((s) => ({
        s,
        day: eventDayKey(s.startsAt, all.event.timezone),
      }));

      const dayParam = c.req.query('day') || '';
      const roomParam = c.req.query('room') || '';
      const rows = withDay.filter(
        (r) => (!dayParam || r.day === dayParam) && (!roomParam || r.s.roomName === roomParam)
      );

      const allDays = [...new Set(withDay.map((r) => r.day))].sort();
      const allRooms = [...new Set(withDay.map((r) => r.s.roomName).filter((x): x is string => !!x))].sort();

      return c.html(
        slidesPage(principal, ev, all.event, rows, { day: dayParam, room: roomParam }, allDays, allRooms)
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.get('/gr/:nonce', async (c) => {
    const nonce = c.req.param('nonce');
    const ev = await eventByGreenRoomNonce(c.env.DB, nonce);
    if (!ev) return c.notFound();

    const day = c.req.query('day') || undefined;
    const gr = await greenRoom(c.env.DB, ev.id, day);
    if (!gr) return c.notFound();

    return c.html(publicGreenRoomPage(ev, gr));
  });
}
