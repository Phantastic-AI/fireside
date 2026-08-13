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
// its own doc comment), plus workflows/files.ts for the decks themselves.
// S-17 writes nothing at all — a runner on one bar of signal changes no
// state. S-18 has exactly one act, asking again, in its two forms.
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
import { reviewerOnly } from '../../queries/settings';
import { principalFromCookie, type Principal } from '../../workflows/account';
import { eventByGreenRoomNonce } from '../../queries/greenroom-token';
import {
  decksAsked,
  stillWaitingCount,
  askAgain,
  askEveryoneWaiting,
  type DeckAsked,
  type FileOutcome,
} from '../../workflows/files';

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

const KB = 1024;

/** A size an organizer can feel, beside the name of the thing. */
const weight = (bytes: number): string =>
  bytes >= KB * KB
    ? `${(bytes / (KB * KB)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / KB))} KB`;

/** The one date "Ask again" writes: a week out, on the conference's own
 *  calendar. Long enough to be answerable, short enough to mean it. */
const aWeekOut = (timezone: string): string =>
  eventDayKey(Date.now() + 7 * 24 * 60 * 60 * 1000, timezone);

/* ------------------------------------------------------------------ *
 * What just happened. The same closed-set discipline the portal keeps:
 * a code in the address, a sentence here, and no free text ever
 * travelling through a query string.
 * ------------------------------------------------------------------ */

const SLIDE_NOTES: Record<string, string> = {
  asked: 'Asked again. The new date is on their list now.',
  'asked-all': 'Asked. Everyone still waiting has the new date on their list.',
  moved: 'The numbers moved while you were looking. What you see now is where they stand.',
  trouble: 'That did not go through, and nothing has changed. Worth trying once more.',
};

function noteLine(code: string | undefined): string {
  const text = code ? SLIDE_NOTES[code] : undefined;
  if (!text) return '';
  return `<div class="sec standing" role="status"><p style="margin:0">${esc(text)}</p></div>`;
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
  const ev = events.find((e) => e.slug === slug);
  // A reviewer holds the reading room and nothing else. The run of show and the
  // slides board both name speakers, so both are the same refusal to them as to
  // somebody with no standing at all — one wall, at the only door in.
  return ev && reviewerOnly(principal, ev.id) ? undefined : ev;
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

/**
 * The masthead's one live fact (fresh-eyes-design-review.md item 2): who
 * runs next, read off the sessions already fetched for the day on screen —
 * no second query. It only says anything when that day is today: `gr.sessions`
 * is scoped to the one day being shown, so there is nothing honest to compare
 * "now" against on any other day. Shared by both doors — the organizer's and
 * the crew's own share link — so Marcus and Naomi read the same sentence.
 */
function upNextFact(gr: GreenRoom): string {
  const nowMs = Date.now();
  if (gr.day !== eventDayKey(nowMs, gr.timezone)) return '';
  const next = gr.sessions
    .filter((s) => !s.cancelled && s.startsAt + s.minutes * 60_000 > nowMs)
    .sort((a, b) => a.startsAt - b.startsAt)[0];
  if (!next) return '';
  const names = byline(next.speakers.map((p) => p.name));
  const subject = names || esc(next.title);
  const room = esc(next.roomName ?? 'no room set');
  const said =
    next.startsAt <= nowMs ? `${subject} is on now, in ${room}.` : `${subject} is next in ${room}.`;
  return `<p class="livefact">${said}</p>`;
}

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
      '<div class="sec standing"><p style="margin:0">No public link yet — nobody outside your ' +
      'team can see this sheet. ' +
      `<a class="link" href="/admin/${encodeURIComponent(slug)}/settings">Create one in settings →</a></p></div>`
    );
  }
  const href = `/gr/${esc(nonce)}`;
  return (
    '<div class="sec standing">' +
    `<p style="margin:0">The public sheet: <a class="link" href="${href}">${href}</a></p>` +
    '<p class="hint" style="margin-top:6px">No sign-in — whoever has this link can open it and see ' +
    "today's run of show, including speaker phone numbers. Rotate it in Settings and the old link " +
    'stops working.</p>' +
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
    upNextFact(gr) +
    `<div class="filters daybar" style="margin-top:12px">${dayTabs(`/admin/${encodeURIComponent(slug)}/green-room`, gr.days, gr.day)}</div>` +
    '</div>';

  const share = hasScope(principal, ev.id, EDIT_ROLES) ? shareRow(slug, nonce) : '';

  const body = gr.sessions.length
    ? `<div class="sec" style="max-width:640px">${sessionCards(gr.sessions, gr.timezone, todayKey)}</div>`
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
    `<span class="sep">·</span>${esc(tzLabel)}</p>` +
    upNextFact(gr) +
    '</div>';

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

type Filters = { day: string; room: string };

/** One row, one act. The filters ride along in the form so that pressing it
 *  puts the organizer back on the same view of the board they were reading. */
function askAgainForm(slug: string, taskId: string, filters: Filters): string {
  return (
    `<form method="post" action="/admin/${encodeURIComponent(slug)}/slides/ask-again" style="margin:0">` +
    `<input type="hidden" name="task" value="${esc(taskId)}">` +
    (filters.day ? `<input type="hidden" name="day" value="${esc(filters.day)}">` : '') +
    (filters.room ? `<input type="hidden" name="room" value="${esc(filters.room)}">` : '') +
    '<button class="btn btn-sm" type="submit">Ask again</button></form>'
  );
}

/**
 * The Detail column, which is where this board earns its place: a deck that
 * is in becomes a link to the deck itself, and a deck that is late becomes
 * the one thing an organizer can do about it.
 */
function slidesDetail(
  s: GreenRoomSession,
  asked: DeckAsked | undefined,
  todayKey: string,
  slug: string,
  filters: Filters
): string {
  if (asked?.file) {
    return (
      `<a class="link" href="/files/${esc(asked.file.id)}">Open the deck</a>` +
      `<br><span class="t-sub">${esc(asked.file.filename)} · ${esc(weight(asked.file.sizeBytes))}</span>`
    );
  }
  // Done, but by hand rather than by sending anything — the chip is true and
  // there is simply nothing here to open.
  if (s.slides === 'present') return '<span class="t-sub">Marked done by the speaker</span>';
  if (s.slides === 'absent' && asked && s.slidesDueOn !== null && s.slidesDueOn < todayKey) {
    return askAgainForm(slug, asked.taskId, filters);
  }
  const due = slidesDueDetail(s.slides, s.slidesDueOn, todayKey);
  return due ? `<span class="t-sub">${esc(due)}</span>` : '';
}

function slidesRow(
  s: GreenRoomSession,
  day: string,
  timezone: string,
  todayKey: string,
  asked: DeckAsked | undefined,
  slug: string,
  filters: Filters
): string {
  const strike = s.cancelled
    ? ' style="text-decoration:line-through;text-decoration-color:var(--muted-2)"'
    : '';
  const names = byline(s.speakers.map((p) => p.name));
  const detail = slidesDetail(s, asked, todayKey, slug, filters);
  return (
    '<tr>' +
    `<td class="num" style="white-space:nowrap"><b>${esc(timeOfDay(s.startsAt, timezone))}</b><br>` +
    `<span class="t-sub">${esc(dayShort(day))}</span></td>` +
    `<td style="white-space:nowrap">${esc(s.roomName ?? 'No room set')}</td>` +
    `<td><span class="t-name"${strike}>${esc(s.title)}</span><br>` +
    `<span class="t-sub">${names || 'No speaker listed'} · ${esc(formatLabel(s.format))} · ${esc(durationLabel(s.minutes))}</span></td>` +
    `<td>${slidesChip(s.slides, s.slidesDueOn, todayKey)}</td>` +
    `<td>${detail}</td>` +
    '</tr>'
  );
}

/**
 * Asking everyone at once, in two passes (D-024). The first pass is a link,
 * so nothing has happened yet and nothing can happen by accident; the second
 * names the number out loud, twice, and only then offers the button. The
 * number the confirm prints travels with the form, and workflows/files.ts
 * guards on it — a board that said twelve can never quietly do fourteen.
 */
function askEveryoneBlock(
  slug: string,
  basePath: string,
  filters: Filters,
  waiting: number,
  dueOn: string,
  confirming: boolean
): string {
  if (waiting < 1) return '';
  const here = { day: filters.day || null, room: filters.room || null };

  if (!confirming) {
    return (
      '<div class="sec attn">' +
      `<div class="n">${esc(num(waiting))}</div>` +
      '<div><div class="lab">Still to come, across the conference.</div>' +
      '<div class="why">Each of these was asked for and has not arrived.</div></div>' +
      `<a class="btn go" href="${esc(withQuery(basePath, { ...here, ask: 'all' }))}">` +
      'Ask everyone at once →</a></div>'
    );
  }

  return (
    '<div class="sec attn">' +
    `<div class="n">${esc(num(waiting))}</div>` +
    `<div><div class="lab">Ask all ${esc(num(waiting))} again</div>` +
    `<div class="why">This puts ${esc(dayShort(dueOn))} on all ${esc(num(waiting))} of the ` +
    'requests still outstanding. Each speaker sees the new date in their portal; nothing ' +
    'goes out from here.</div></div>' +
    `<div class="btnrow go"><form method="post" action="/admin/${encodeURIComponent(slug)}/slides/ask-all" style="margin:0">` +
    `<input type="hidden" name="count" value="${esc(String(waiting))}">` +
    (filters.day ? `<input type="hidden" name="day" value="${esc(filters.day)}">` : '') +
    (filters.room ? `<input type="hidden" name="room" value="${esc(filters.room)}">` : '') +
    `<button class="btn btn-primary" type="submit">Ask all ${esc(num(waiting))}</button></form>` +
    `<a class="btn" href="${esc(withQuery(basePath, here))}">${esc(label('pane.leave', 'backstage'))}</a>` +
    '</div></div>'
  );
}

function slidesPage(
  principal: Principal,
  ev: AdminEvent,
  gr: GreenRoom,
  rows: { s: GreenRoomSession; day: string }[],
  filters: Filters,
  allDays: string[],
  allRooms: string[],
  asked: Map<string, DeckAsked>,
  waiting: number,
  confirming: boolean,
  note: string | undefined
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
    noteLine(note) +
    (total && inCount === total
      ? '<div class="sec attn" style="background:var(--go-wash);border-color:#CBE0D1">' +
        `<div><div class="lab">Every deck is in. ${esc(num(inCount))} of ${esc(num(total))}.</div></div></div>`
      : '') +
    // The banner above counts what is on the board, which a day or a room
    // filter can narrow; this counts what the conference is waiting on, and
    // says so, so the two numbers can differ without either being a lie.
    askEveryoneBlock(slug, basePath, filters, waiting, aWeekOut(gr.timezone), confirming);

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
      rows
        .map((r) => slidesRow(r.s, r.day, gr.timezone, todayKey, asked.get(r.s.id), slug, filters))
        .join('') +
      '</tbody></table></div>' +
      '<p class="hint" style="margin-top:12px">Asking again moves the date on the request. The ' +
      'speaker sees the new date in their portal.</p>';
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

      const [asked, waiting] = await Promise.all([
        decksAsked(c.env.DB, ev.id),
        stillWaitingCount(c.env.DB, ev.id),
      ]);
      // The confirm is a place, not a piece of state: an address an organizer
      // can back out of with the browser's own button.
      const confirming = c.req.query('ask') === 'all' && hasScope(principal, ev.id, EDIT_ROLES);

      return c.html(
        slidesPage(
          principal,
          ev,
          all.event,
          rows,
          { day: dayParam, room: roomParam },
          allDays,
          allRooms,
          asked,
          waiting,
          confirming,
          c.req.query('note')
        )
      );
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  /* ---------------------------------------------------------------- *
   * Asking again — S-18's one act, in its two forms. Both write the
   * same single column through workflows/files.ts, both are undone by
   * pressing the same thing again, and neither sends anything: the
   * outbox is somebody else's screen and this one does not pretend
   * otherwise.
   * ---------------------------------------------------------------- */

  const boardPath = (slug: string, form: Record<string, string | File>, note: string): string =>
    withQuery(`/admin/${encodeURIComponent(slug)}/slides`, {
      day: String(form['day'] ?? '') || null,
      room: String(form['room'] ?? '') || null,
      note,
    });

  const said = (outcome: FileOutcome, done: string): string =>
    outcome === 'done' ? done : outcome === 'moved' ? 'moved' : 'trouble';

  app.post('/admin/:eventSlug/slides/ask-again', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    try {
      const ev = await eventFor(c.env.DB, principal, slug);
      if (!ev) return c.html(deniedPage(), 403);
      requireScope(principal, ev.id, EDIT_ROLES);

      const form = await c.req.parseBody();
      const taskId = String(form['task'] ?? '');
      if (!taskId) return c.redirect(boardPath(slug, form, 'moved'), 303);

      const outcome = await askAgain(c.env.DB, ev.id, taskId, aWeekOut(ev.timezone));
      return c.redirect(boardPath(slug, form, said(outcome, 'asked')), 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/:eventSlug/slides/ask-all', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in', 303);

    const slug = c.req.param('eventSlug');
    try {
      const ev = await eventFor(c.env.DB, principal, slug);
      if (!ev) return c.html(deniedPage(), 403);
      requireScope(principal, ev.id, EDIT_ROLES);

      const form = await c.req.parseBody();
      // The number the confirm printed. The guard in workflows/files.ts holds
      // the batch to exactly it, so a stale page cannot act on a stale count.
      const counted = Number(String(form['count'] ?? ''));
      if (!Number.isInteger(counted) || counted < 1) {
        return c.redirect(boardPath(slug, form, 'moved'), 303);
      }

      const outcome = await askEveryoneWaiting(c.env.DB, ev.id, aWeekOut(ev.timezone), counted);
      return c.redirect(boardPath(slug, form, said(outcome, 'asked-all')), 303);
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
