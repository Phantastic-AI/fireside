// The agenda builder's read path — S-14's one query. Naomi is building
// Thursday while Wednesday burns, so this returns the whole screen in one
// batch: the days, the rooms, the slot times, what is on the grid, and what is
// still waiting for a room.
//
// Scope is checked here, at the chokepoint, exactly as queries/admin.ts does
// it: reading the grid is every backstage standing; moving anything on it is
// EDIT_ROLES, and the answer to "may this person move things" rides along in
// the DTO so the screen never renders a control that would refuse.
//
// Times: starts_at is epoch ms; day_start/day_end are wall clocks ('09:30') in
// the event's own timezone, and a conference day is a local fact, so every
// conversion goes through the event timezone rather than UTC.

import type { Principal } from '../workflows/account';
import { requireScope, READ_ROLES, EDIT_ROLES } from './admin';
import { eventDayKey } from './public';

/* ------------------------------------------------------------------ *
 * Wall clock ↔ instant, in the event's own timezone
 * ------------------------------------------------------------------ */

/** The zone's offset from UTC at an instant, in ms. */
function offsetAt(ms: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * A wall date ('2026-09-03') and a wall clock ('09:30') in a timezone, as an
 * instant. Two passes, because the offset that applies is the offset at the
 * answer, not at the guess — the day a clock shifts is the day a conference
 * schedule would otherwise slide by an hour.
 */
export function wallToEpoch(dayIso: string, hhmm: string, timezone: string): number {
  const d = dayIso.split('-');
  const t = hhmm.split(':');
  const guess = Date.UTC(
    Number(d[0] ?? '1970'),
    Number(d[1] ?? '1') - 1,
    Number(d[2] ?? '1'),
    Number(t[0] ?? '0'),
    Number(t[1] ?? '0')
  );
  const first = guess - offsetAt(guess, timezone);
  const second = guess - offsetAt(first, timezone);
  return second;
}

/** The next wall day after an ISO day key. */
function nextDay(dayIso: string): string {
  const d = dayIso.split('-');
  const ms = Date.UTC(Number(d[0] ?? '1970'), Number(d[1] ?? '1') - 1, Number(d[2] ?? '1')) + 86_400_000;
  const next = new Date(ms);
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${next.getUTCFullYear()}-${mm}-${dd}`;
}

/* ------------------------------------------------------------------ *
 * DTOs — internal enums and computed facts only, never display words.
 * ------------------------------------------------------------------ */

export type BuilderRoom = { id: string; name: string };

export type BuilderTrack = { name: string; colour: string };

/** A talk with a time and a room. Cancelled keeps its place (01 inv. 2/Δ4). */
export type BuilderSession = {
  id: string;
  title: string;
  state: 'accepted' | 'cancelled';
  cancelled: boolean;
  cancelNote: string | null;
  startsAt: number;
  minutes: number;
  format: string;
  roomId: string | null;
  roomName: string | null;
  track: BuilderTrack | null;
  speakers: string[];
  /** The local ISO day this sits on, in the event's own timezone. */
  day: string;
};

/** An accepted talk with nowhere to be yet. */
export type BuilderWaiting = {
  id: string;
  title: string;
  format: string;
  minutes: number;
  track: BuilderTrack | null;
  speakers: string[];
};

export type Builder = {
  eventId: string;
  slug: string;
  name: string;
  timezone: string;
  tzLabel: string | null;
  agendaPublished: boolean;
  /** Every day of the event, plus any day something already sits on. */
  days: string[];
  /** The day being shown. */
  day: string;
  rooms: BuilderRoom[];
  /** Row starts for `day`: the event's own blocks, plus any time in use. */
  slots: number[];
  /** On the grid, this day only. */
  placed: BuilderSession[];
  /** Accepted, no room yet — the rail. */
  waiting: BuilderWaiting[];
  /** May this person move things, or only read them. */
  canEdit: boolean;
  counts: {
    /** On the grid across the whole event — the number publishing carries. */
    placed: number;
    /** On the grid on the day being shown. */
    placedToday: number;
    waiting: number;
    rooms: number;
    days: number;
  };
};

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

type EventRow = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  tz_label: string | null;
  starts_on: string;
  ends_on: string;
  day_start: string;
  day_end: string;
  block_minutes: number;
  agenda_published: number;
};

type SessionRow = {
  id: string;
  title: string;
  state: 'accepted' | 'cancelled';
  starts_at: number | null;
  requested_min: number;
  format: string;
  room_id: string | null;
  cancel_note: string | null;
  room_name: string | null;
  track_name: string | null;
  track_colour: string | null;
};

function rowsOf<T>(res: D1Result<Record<string, unknown>> | undefined): T[] {
  return (res?.results ?? []) as unknown as T[];
}

function canEditHere(principal: Principal, eventId: string): boolean {
  if (principal.role === 'organizer') return true;
  const role = principal.eventRoles[eventId];
  return role !== undefined && EDIT_ROLES.includes(role);
}

/** The one place a room id turns into the id the writers may be handed. */
export async function eventIdBySlug(db: D1Database, slug: string): Promise<string | null> {
  const row = await db.prepare('SELECT id FROM event WHERE slug = ?').bind(slug).first<{ id: string }>();
  return row?.id ?? null;
}

/* ------------------------------------------------------------------ *
 * The builder
 * ------------------------------------------------------------------ */

const MAX_SLOTS = 96;

/**
 * The whole screen. `day` picks a day; anything else falls back to today in
 * the event's own timezone, and then to the first day of the event.
 */
export async function agendaBuilder(
  db: D1Database,
  principal: Principal,
  eventSlug: string,
  day?: string,
  nowMs: number = Date.now()
): Promise<Builder | null> {
  const ev = await db
    .prepare(
      `SELECT id, slug, name, timezone, tz_label, starts_on, ends_on,
              day_start, day_end, block_minutes, agenda_published
       FROM event WHERE slug = ?`
    )
    .bind(eventSlug)
    .first<EventRow>();
  if (!ev) return null;

  requireScope(principal, ev.id, READ_ROLES);

  const [roomRes, sessionRes, speakerRes] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT id, name FROM room WHERE event_id = ? ORDER BY position, name').bind(ev.id),
    db
      .prepare(
        `SELECT s.id, s.title, s.state, s.starts_at, s.requested_min, s.format, s.room_id,
                s.cancel_note, r.name AS room_name,
                t.name AS track_name, t.colour AS track_colour
         FROM submission s
         LEFT JOIN room r ON r.id = s.room_id
         LEFT JOIN track t ON t.id = s.track_id
         WHERE s.event_id = ? AND s.state IN ('accepted','cancelled')
         ORDER BY s.starts_at IS NULL, s.starts_at, r.position, r.name, s.title`
      )
      .bind(ev.id),
    db
      .prepare(
        `SELECT pa.submission_id, pe.name
         FROM participation pa
         JOIN person pe ON pe.id = pa.person_id
         JOIN submission s ON s.id = pa.submission_id
         WHERE s.event_id = ? AND s.state IN ('accepted','cancelled')
         ORDER BY pa.submission_id, pa.is_submitter DESC, pa.position, pe.name`
      )
      .bind(ev.id),
  ]);

  const speakers = new Map<string, string[]>();
  for (const r of rowsOf<{ submission_id: string; name: string }>(speakerRes)) {
    const list = speakers.get(r.submission_id) ?? [];
    list.push(r.name);
    speakers.set(r.submission_id, list);
  }
  const trackOf = (r: SessionRow): BuilderTrack | null =>
    r.track_name && r.track_colour ? { name: r.track_name, colour: r.track_colour } : null;

  const rows = rowsOf<SessionRow>(sessionRes);
  const placedAll: BuilderSession[] = [];
  const waiting: BuilderWaiting[] = [];
  for (const r of rows) {
    if (r.starts_at === null) {
      // A cancelled talk that was never placed belongs to the pile, not here.
      if (r.state !== 'accepted') continue;
      waiting.push({
        id: r.id,
        title: r.title,
        format: r.format,
        minutes: r.requested_min,
        track: trackOf(r),
        speakers: speakers.get(r.id) ?? [],
      });
      continue;
    }
    placedAll.push({
      id: r.id,
      title: r.title,
      state: r.state,
      cancelled: r.state === 'cancelled',
      cancelNote: r.cancel_note,
      startsAt: r.starts_at,
      minutes: r.requested_min,
      format: r.format,
      roomId: r.room_id,
      roomName: r.room_name,
      track: trackOf(r),
      speakers: speakers.get(r.id) ?? [],
      day: eventDayKey(r.starts_at, ev.timezone),
    });
  }

  // The days: every day of the event, plus any day something already sits on
  // — a talk placed outside the published dates still has to be visible.
  const days: string[] = [];
  for (let d = ev.starts_on; d <= ev.ends_on && days.length < 32; d = nextDay(d)) days.push(d);
  for (const s of placedAll) if (!days.includes(s.day)) days.push(s.day);
  days.sort();
  if (days.length === 0) days.push(eventDayKey(nowMs, ev.timezone));

  const today = eventDayKey(nowMs, ev.timezone);
  const chosen =
    day && days.includes(day) ? day : days.includes(today) ? today : (days[0] as string);

  const placed = placedAll.filter((s) => s.day === chosen);

  // The rows: the event's own blocks between day_start and day_end, plus every
  // time already in use that day. A talk at 14:00 on a 09:30 half-hour grid is
  // a fact about the program, not a mistake to hide.
  const step = Math.max(5, ev.block_minutes) * 60_000;
  const open = wallToEpoch(chosen, ev.day_start, ev.timezone);
  const close = wallToEpoch(chosen, ev.day_end, ev.timezone);
  const slots = new Set<number>();
  for (let t = open, i = 0; t < close && i < MAX_SLOTS; t += step, i++) slots.add(t);
  for (const s of placed) slots.add(s.startsAt);
  const slotList = [...slots].sort((a, b) => a - b);
  const rooms = rowsOf<BuilderRoom>(roomRes);

  return {
    eventId: ev.id,
    slug: ev.slug,
    name: ev.name,
    timezone: ev.timezone,
    tzLabel: ev.tz_label,
    agendaPublished: ev.agenda_published === 1,
    days,
    day: chosen,
    rooms,
    slots: slotList,
    placed,
    waiting,
    canEdit: canEditHere(principal, ev.id),
    counts: {
      placed: placedAll.length,
      placedToday: placed.length,
      waiting: waiting.length,
      rooms: rooms.length,
      days: days.length,
    },
  };
}
