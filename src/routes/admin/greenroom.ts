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
  arrivalsFor,
  checkinLinks,
  mintCheckinLink,
  revokeCheckinLink,
  type CheckinLinkRow,
} from '../../workflows/checkin';
import {
  deliverableRows,
  stillWaitingCount,
  askAgain,
  askEveryoneWaiting,
  type DeliverableRow,
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
  asked: 'Asked again. They have a reminder with the new date now.',
  'asked-all': 'Asked. Everyone still waiting has a reminder with the new date now.',
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

type Arrival = { at: string; who: string };

function sessionCard(s: GreenRoomSession, todayKey: string, arrival?: Arrival): string {
  const strike = s.cancelled
    ? ' style="text-decoration:line-through;text-decoration-color:var(--muted-2)"'
    : '';
  const names = s.speakers.map((p) => p.name);
  const nameLine = byline(names) || 'No speaker listed';
  const cancelledNote = s.cancelled
    ? `<p class="sub" style="margin:-4px 0 10px">${esc(label('submission.cancelled', 'backstage'))}</p>`
    : '';
  // T611 — which hands marked them in, and when. Absent until somebody does.
  const arrivedNote = arrival
    ? `<p class="sub" style="margin:-2px 0 8px">✓ arrived ${esc(arrival.at)} · ${esc(arrival.who)}</p>`
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
    arrivedNote +
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
function sessionCards(
  sessions: GreenRoomSession[],
  timezone: string,
  todayKey: string,
  arrivals: Map<string, Arrival> = new Map()
): string {
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
    html += sessionCard(s, todayKey, arrivals.get(s.id));
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

function checkinSection(slug: string, links: CheckinLinkRow[]): string {
  const rows = links
    .map((l) => {
      const state = l.revokedAt
        ? '<span class="sub">revoked</span>'
        : `<a class="link" href="/ci/${esc(l.nonce)}">/ci/${esc(l.nonce.slice(0, 10))}…</a>`;
      const off = l.revokedAt
        ? ''
        : `<form method="post" action="/admin/${encodeURIComponent(slug)}/green-room/checkin/revoke" style="display:inline">` +
          `<input type="hidden" name="id" value="${esc(l.id)}">` +
          '<button class="btn btn-sm btn-quiet" type="submit">Revoke</button></form>';
      return `<p style="margin:6px 0 0"><b>${esc(l.name)}</b> · ${state} ${off}</p>`;
    })
    .join('');
  return (
    '<div class="sec standing">' +
    '<p style="margin:0"><b>Check-in links</b> — a named link per volunteer. Whoever holds it can ' +
    'mark today&#39;s speakers arrived, and every mark carries the link&#39;s name and the time. ' +
    'Nothing else opens with it.</p>' +
    rows +
    `<form method="post" action="/admin/${encodeURIComponent(slug)}/green-room/checkin" ` +
    'style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
    '<input type="text" name="name" maxlength="60" placeholder="Sam, front door" aria-label="Who holds it">' +
    '<button class="btn btn-sm" type="submit">Mint a link</button></form>' +
    '</div>'
  );
}

function adminGreenRoomPage(
  principal: Principal,
  ev: AdminEvent,
  gr: GreenRoom,
  nonce: string | null,
  links: CheckinLinkRow[],
  arrivals: Map<string, { at: string; who: string }>
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
  const checkin = hasScope(principal, ev.id, EDIT_ROLES) ? checkinSection(slug, links) : '';

  const body = gr.sessions.length
    ? `<div class="sec" style="max-width:640px">${sessionCards(gr.sessions, gr.timezone, todayKey, arrivals)}</div>`
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
      body: head + share +
    checkin + body,
    }),
  });
}

/* ------------------------------------------------------------------ *
 * S-17, door two: /gr/:nonce — no sign-in, no nav chrome, just the day.
 * The lightest page in the product, by law: the same session-card markup
 * as the admin door, no day switcher, no other link on the page at all.
 * ------------------------------------------------------------------ */

function publicGreenRoomPage(
  ev: { name: string },
  gr: GreenRoom,
  arrivals: Map<string, { at: string; who: string }> = new Map()
): string {
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
    ? `<div class="sec" style="max-width:640px">${sessionCards(gr.sessions, gr.timezone, todayKey, arrivals)}</div>`
    : '<div class="sec state-out"><h2>Nothing scheduled yet.</h2>' +
      '<p>Check back closer to the day.</p></div>';

  return page({
    title: `Green room · ${ev.name}`,
    register: 'backstage',
    body: '<div class="stage backstage"><main><div class="wrap" style="padding-bottom:40px">' + head + body + '</div></main></div>',
  });
}

/* ------------------------------------------------------------------ *
 * S-18: /admin/:eventSlug/slides — the Deliverables board.
 *
 * One row per open file-request task, event-wide — not one per session. A
 * talk that owes both a deck and a headshot used to collapse onto one row,
 * so the board could show a headshot's status under a slides label and the
 * banner's own count (every open request) never matched the table's (one row
 * per talk). Reading workflows/files.ts's deliverableRows() — one row per
 * request, with the request's own title on it — is what keeps both true at
 * once: the table IS the set stillWaitingCount() counts, filtered or not.
 * ------------------------------------------------------------------ */

type StatusFilter = 'all' | 'incomplete' | 'overdue';
type Filters = { status: StatusFilter; task: string };

const STATUS_WORD: Record<StatusFilter, string> = {
  all: 'Every status',
  incomplete: 'Not in yet',
  overdue: 'Overdue',
};

function matchesStatus(r: DeliverableRow, status: StatusFilter, todayKey: string): boolean {
  if (status === 'all') return true;
  if (r.file !== null) return false;
  if (status === 'overdue') return r.dueOn !== null && r.dueOn < todayKey;
  return true; // incomplete: every open request, overdue or not
}

/** One row, one act. The filters ride along in the form so that pressing it
 *  puts the organizer back on the same view of the board they were reading.
 *  CNT-08: honest about what the click does before it happens, not only after
 *  — the button used to say "Ask again" with nothing beside it, and moved the
 *  date without telling the speaker at all. It moves the date and reminds
 *  them now; both facts sit right above the button. */
function askAgainForm(slug: string, r: DeliverableRow, dueOn: string, filters: Filters): string {
  return (
    `<span class="t-sub">Moves the due date to ${esc(dayShort(dueOn))} and reminds ${esc(r.personName)} — ` +
    'it lands in their portal at once, and a real address gets an email too.</span><br>' +
    `<form method="post" action="/admin/${encodeURIComponent(slug)}/slides/ask-again" style="margin-top:4px">` +
    `<input type="hidden" name="task" value="${esc(r.taskId)}">` +
    (filters.status !== 'all' ? `<input type="hidden" name="status" value="${esc(filters.status)}">` : '') +
    (filters.task ? `<input type="hidden" name="task_filter" value="${esc(filters.task)}">` : '') +
    '<button class="btn btn-sm" type="submit">Ask again</button></form>'
  );
}

/** The Status column: reuses the file.* words 02 §6 already gives an
 *  organizer for "is it in" — the same words the old per-session chip used,
 *  now read straight off the request instead of off whichever request won a
 *  race between two on the same talk. */
function deliverableChip(r: DeliverableRow, todayKey: string): string {
  if (r.file !== null) {
    return `<span class="chip s-accepted">${esc(label('file.present', 'backstage'))}</span>`;
  }
  const overdue = r.dueOn !== null && r.dueOn < todayKey;
  if (overdue) {
    const text = label('file.absent_overdue', 'backstage').replace('{date}', dayShort(r.dueOn!));
    return `<span class="chip warn">${esc(text)}</span>`;
  }
  return `<span class="chip s-undecided">${esc(label('file.absent', 'backstage'))}</span>`;
}

/**
 * The Detail column, which is where this board earns its place: a deliverable
 * that is in becomes a link to it (with a version count once there is more
 * than one to count), and one that is late becomes the one thing an organizer
 * can do about it.
 */
function deliverableDetail(r: DeliverableRow, todayKey: string, slug: string, filters: Filters, dueOn: string): string {
  if (r.file !== null) {
    const versions = r.versionCount > 1 ? ` · ${esc(plural(r.versionCount, 'version', 'versions'))}` : '';
    return (
      `<a class="link" href="/files/${esc(r.file.id)}/detail">Open the file</a>` +
      `<br><span class="t-sub">${esc(r.file.filename)} · ${esc(weight(r.file.sizeBytes))}${versions}</span>`
    );
  }
  const overdue = r.dueOn !== null && r.dueOn < todayKey;
  if (overdue) return askAgainForm(slug, r, dueOn, filters);
  return r.dueOn !== null ? `<span class="t-sub">due ${esc(dayShort(r.dueOn))}</span>` : '';
}

function deliverableRow(r: DeliverableRow, slug: string, todayKey: string, filters: Filters, dueOn: string): string {
  const who = r.submissionTitle
    ? `<span class="t-name">${esc(r.personName)}</span><br><span class="t-sub">${esc(r.submissionTitle)}</span>`
    : `<span class="t-name">${esc(r.personName)}</span>`;
  const what =
    `${esc(r.title)}` +
    (r.dueOn !== null
      ? `<br><span class="t-sub">${r.dueOn < todayKey && r.file === null ? 'Was due ' : 'Due '}${esc(dayShort(r.dueOn))}</span>`
      : '');
  return (
    '<tr>' +
    `<td>${who}</td>` +
    `<td>${what}</td>` +
    `<td>${deliverableChip(r, todayKey)}</td>` +
    `<td>${deliverableDetail(r, todayKey, slug, filters, dueOn)}</td>` +
    '</tr>'
  );
}

/**
 * Asking everyone at once, in two passes (D-024). The first pass is a link,
 * so nothing has happened yet and nothing can happen by accident; the second
 * names the number out loud, twice, and only then offers the button. The
 * number the confirm prints travels with the form, and workflows/files.ts
 * guards on it — a board that said twelve can never quietly do fourteen.
 *
 * CNT-08: both passes now say plainly that this changes due dates and
 * reminds every speaker who still owes something — a note in their portal at
 * once, and an email too for a real address. The old confirm claimed the
 * opposite ("no email goes out"); the reminder is real now, so the copy says
 * so up front, not only after the organizer has already committed to
 * clicking through.
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
  const here: Record<string, string | null> = {
    status: filters.status !== 'all' ? filters.status : null,
    task: filters.task || null,
  };

  if (!confirming) {
    return (
      '<div class="sec attn">' +
      `<div class="n">${esc(num(waiting))}</div>` +
      '<div><div class="lab">Still to come, across the conference.</div>' +
      `<div class="why">Each of these was asked for and has not arrived. Asking again moves its ` +
      'due date out and reminds every speaker who still owes something — it lands in their portal ' +
      'at once, and real addresses get an email too.</div></div>' +
      `<a class="btn go" href="${esc(withQuery(basePath, { ...here, ask: 'all' }))}">` +
      'Ask everyone at once →</a></div>'
    );
  }

  return (
    '<div class="sec attn">' +
    `<div class="n">${esc(num(waiting))}</div>` +
    `<div><div class="lab">Move the due date on all ${esc(num(waiting))}</div>` +
    `<div class="why">Every request still outstanding gets ${esc(dayShort(dueOn))} as its new due ` +
    `date, and each speaker who still owes something gets a reminder naming what is still due: it ` +
    'lands in their portal at once, and real addresses get an email too.</div></div>' +
    `<div class="btnrow go"><form method="post" action="/admin/${encodeURIComponent(slug)}/slides/ask-all" style="margin:0">` +
    `<input type="hidden" name="count" value="${esc(String(waiting))}">` +
    (filters.status !== 'all' ? `<input type="hidden" name="status" value="${esc(filters.status)}">` : '') +
    (filters.task ? `<input type="hidden" name="task_filter" value="${esc(filters.task)}">` : '') +
    `<button class="btn btn-primary" type="submit">Move all ${esc(num(waiting))} due dates</button></form>` +
    `<a class="btn" href="${esc(withQuery(basePath, here))}">${esc(label('pane.leave', 'backstage'))}</a>` +
    '</div></div>'
  );
}

function deliverablesPage(
  principal: Principal,
  ev: AdminEvent,
  timezone: string,
  tzLabel: string | null,
  all: DeliverableRow[],
  rows: DeliverableRow[],
  filters: Filters,
  taskTitles: string[],
  waiting: number,
  confirming: boolean,
  note: string | undefined
): string {
  const slug = ev.slug;
  const todayKey = eventDayKey(Date.now(), timezone);
  const total = all.length;
  const inCount = all.filter((r) => r.file !== null).length;
  const pct = total ? Math.round((inCount / total) * 100) : 0;
  const dueOn = aWeekOut(timezone);

  const basePath = `/admin/${encodeURIComponent(slug)}/slides`;
  const statusChips = (Object.keys(STATUS_WORD) as StatusFilter[])
    .map(
      (s) =>
        `<a class="fchip" href="${esc(withQuery(basePath, { status: s === 'all' ? null : s, task: filters.task || null }))}" aria-pressed="${filters.status === s}">${esc(STATUS_WORD[s])}</a>`
    )
    .join('');
  const taskChips = taskTitles.length
    ? `<a class="fchip" href="${esc(withQuery(basePath, { status: filters.status !== 'all' ? filters.status : null, task: null }))}" aria-pressed="${!filters.task}">Every deliverable</a>` +
      taskTitles
        .map(
          (t) =>
            `<a class="fchip" href="${esc(withQuery(basePath, { status: filters.status !== 'all' ? filters.status : null, task: t }))}" aria-pressed="${filters.task === t}">${esc(t)}</a>`
        )
        .join('')
    : '';

  const head =
    '<div style="padding:26px 0 0"><h1 class="display">Deliverables</h1>' +
    '<p class="counts">' +
    (total
      ? `<b>${esc(num(inCount))} of ${esc(num(total))} in</b> (${pct}%)`
      : '<b>Nothing asked for yet</b>') +
    `<span class="sep">·</span>${esc(tzLabel ?? timezone)}</p></div>` +
    `<div class="filters scrollx daybar" style="margin-top:14px">${statusChips}</div>` +
    (taskChips ? `<div class="filters scrollx daybar">${taskChips}</div>` : '') +
    noteLine(note) +
    (total && inCount === total
      ? '<div class="sec attn" style="background:var(--go-wash);border-color:#CBE0D1">' +
        `<div><div class="lab">Everything asked for is in. ${esc(num(inCount))} of ${esc(num(total))}.</div></div></div>`
      : '') +
    // The banner above counts what the current filter shows; this counts every
    // open request event-wide, and the two are the same set of rows unfiltered
    // — deliverableRows() is the one source both this and the table read.
    askEveryoneBlock(slug, basePath, filters, waiting, dueOn, confirming);

  let body: string;
  if (total === 0) {
    body =
      '<div class="sec state-out"><h2>Nothing asked for yet.</h2>' +
      '<p>Ask a speaker for something from their proposal and it turns up here, with a due date.</p>' +
      `<a class="btn btn-primary" href="/admin/${encodeURIComponent(slug)}/submissions">Go to proposals →</a></div>`;
  } else if (rows.length === 0) {
    body =
      '<div class="sec state-out"><h2>Nothing here with those filters.</h2>' +
      `<a class="btn btn-primary" href="${basePath}">Show every request →</a></div>`;
  } else {
    body =
      '<div class="tablewrap" style="margin-top:16px"><table class="t"><thead><tr>' +
      '<th>Speaker</th><th>Deliverable</th><th>Status</th><th>Detail</th></tr></thead><tbody>' +
      rows.map((r) => deliverableRow(r, slug, todayKey, filters, dueOn)).join('') +
      '</tbody></table></div>' +
      '<p class="hint" style="margin-top:12px">Asking again moves the due date on the request and ' +
      'reminds the speaker: it lands in their portal at once, and a real address gets an email too.</p>';
  }

  return page({
    title: `Deliverables · ${ev.name}`,
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
      const [links, arrivals] = await Promise.all([
        checkinLinks(c.env.DB, ev.id),
        arrivalsFor(c.env.DB, ev.id, gr.timezone),
      ]);

      return c.html(adminGreenRoomPage(principal, ev, gr, nonce, links, arrivals));
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

      const all = await deliverableRows(c.env.DB, ev.id);
      const todayKey = eventDayKey(Date.now(), ev.timezone);

      const statusParam = c.req.query('status') || '';
      const status: StatusFilter =
        statusParam === 'incomplete' || statusParam === 'overdue' ? statusParam : 'all';
      const taskParam = c.req.query('task_filter') || '';
      const rows = all.filter(
        (r) => matchesStatus(r, status, todayKey) && (!taskParam || r.title === taskParam)
      );
      const taskTitles = [...new Set(all.map((r) => r.title))].sort();

      const waiting = await stillWaitingCount(c.env.DB, ev.id);
      // The confirm is a place, not a piece of state: an address an organizer
      // can back out of with the browser's own button.
      const confirming = c.req.query('ask') === 'all' && hasScope(principal, ev.id, EDIT_ROLES);

      return c.html(
        deliverablesPage(
          principal,
          ev,
          ev.timezone,
          ev.tzLabel,
          all,
          rows,
          { status, task: taskParam },
          taskTitles,
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
      status: String(form['status'] ?? '') || null,
      task_filter: String(form['task_filter'] ?? '') || null,
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

      const outcome = await askAgain(
        c.env.DB,
        ev.id,
        taskId,
        aWeekOut(ev.timezone),
        c.env.EMAIL && c.env.FROM_EMAIL ? { binding: c.env.EMAIL, from: c.env.FROM_EMAIL } : null,
        (p) => c.executionCtx.waitUntil(p),
        c.env.SITE_ORIGIN
      );
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

      const outcome = await askEveryoneWaiting(
        c.env.DB,
        ev.id,
        aWeekOut(ev.timezone),
        counted,
        c.env.EMAIL && c.env.FROM_EMAIL ? { binding: c.env.EMAIL, from: c.env.FROM_EMAIL } : null,
        (p) => c.executionCtx.waitUntil(p),
        c.env.SITE_ORIGIN
      );
      return c.redirect(boardPath(slug, form, said(outcome, 'asked-all')), 303);
    } catch (e) {
      if (e instanceof ScopeError) return c.html(deniedPage(e.message), 403);
      throw e;
    }
  });

  app.post('/admin/:eventSlug/green-room/checkin', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');
    const ev = await eventFor(c.env.DB, principal, c.req.param('eventSlug'));
    if (!ev || !hasScope(principal, ev.id, EDIT_ROLES)) return c.html(deniedPage(), 403);
    const form = await c.req.parseBody();
    await mintCheckinLink(c.env.DB, ev.id, typeof form['name'] === 'string' ? form['name'] : '');
    return c.redirect(`/admin/${encodeURIComponent(ev.slug)}/green-room`, 303);
  });

  app.post('/admin/:eventSlug/green-room/checkin/revoke', async (c) => {
    const principal = await principalFromCookie(c.env.DB, c.env.SESSION_SECRET, c.req.header('cookie'));
    if (!principal) return c.redirect('/sign-in');
    const ev = await eventFor(c.env.DB, principal, c.req.param('eventSlug'));
    if (!ev || !hasScope(principal, ev.id, EDIT_ROLES)) return c.html(deniedPage(), 403);
    const form = await c.req.parseBody();
    await revokeCheckinLink(c.env.DB, ev.id, typeof form['id'] === 'string' ? form['id'] : '');
    return c.redirect(`/admin/${encodeURIComponent(ev.slug)}/green-room`, 303);
  });

  app.get('/gr/:nonce', async (c) => {
    const nonce = c.req.param('nonce');
    const ev = await eventByGreenRoomNonce(c.env.DB, nonce);
    if (!ev) return c.notFound();

    const day = c.req.query('day') || undefined;
    const gr = await greenRoom(c.env.DB, ev.id, day);
    if (!gr) return c.notFound();
    const arrivals = await arrivalsFor(c.env.DB, ev.id, gr.timezone);

    return c.html(publicGreenRoomPage(ev, gr, arrivals));
  });
}
