// Building the program: the six writes that move a talk onto a day, off it,
// out of it, and back — and the two that decide whether the public may see any
// of it at all.
//
// Every one of them is a guarded checkedBatch. The conflict law is the
// database's, not this file's: the room-overlap trigger in schema/0001 refuses
// two live sessions in one room, and the speaker-overlap guard below refuses
// one person in two rooms at once. Both refusals come back as a small closed
// word, and the *screen* says the sentence — a person double-booked is news,
// not a stack trace.
//
// Nothing here mints or sends a letter. Deciding is workflows/decide.ts and
// telling is workflows/release.ts; placement is neither.

import { checkedBatch, guard, newId, now, ChangesMismatchError, StaleStateError } from '../lib/db';
import { requireScope, EDIT_ROLES } from '../queries/admin';
import type { Principal } from './account';

/**
 * What happened, in words the builder knows how to say:
 *   'moved'        — it changed under them; nothing was written
 *   'not-accepted' — only an accepted talk goes on the grid
 *   'room-taken'   — the room already has someone in it then
 *   'speaker-busy' — one of these people is already on stage then
 *   'count-moved'  — the number they read is no longer the number
 *   'trouble'      — something unexpected; nothing was written
 */
export type AgendaFailure =
  | 'moved'
  | 'not-accepted'
  | 'room-taken'
  | 'speaker-busy'
  | 'count-moved'
  | 'trouble';

export type AgendaResult =
  | { ok: true }
  /** `clashId` names the talk already in the way, so the screen can name a person. */
  | { ok: false; reason: AgendaFailure; clashId?: string };

// Never rendered: checkedBatch wants a message for the StaleStateError it
// throws. The organizer's own words live in routes/admin/agenda.ts.
const STALE = 'the grid moved';

function failureOf(e: unknown, where: string): AgendaFailure {
  if (e instanceof StaleStateError) return 'moved';
  if (e instanceof ChangesMismatchError) return 'moved';
  const text = String(e);
  if (/room overlap/i.test(text)) return 'room-taken';
  if (/illegal transition/i.test(text)) return 'moved';
  if (/UNIQUE constraint/i.test(text)) return 'moved';
  console.error(`${where}: ${text}`);
  return 'trouble';
}

/* ------------------------------------------------------------------ *
 * The conflict law
 * ------------------------------------------------------------------ */

/**
 * One person, two rooms, one moment. Bound as ?1 event, ?2 this talk,
 * ?3 the start, ?4 the length in minutes — the same shape the room-overlap
 * trigger uses, so the two laws agree about what "at the same time" means.
 */
const SPEAKER_CLASH = `
  SELECT s2.id AS clash_id FROM submission s2
   WHERE s2.event_id = ?1
     AND s2.id <> ?2
     AND s2.state = 'accepted'
     AND s2.starts_at IS NOT NULL
     AND s2.starts_at < ?3 + ?4 * 60000
     AND ?3 < s2.starts_at + s2.requested_min * 60000
     AND EXISTS (
       SELECT 1 FROM participation p1
        JOIN participation p2 ON p2.person_id = p1.person_id
        WHERE p1.submission_id = ?2 AND p2.submission_id = s2.id)`;

async function speakerClash(
  db: D1Database,
  eventId: string,
  submissionId: string,
  startsAt: number,
  minutes: number
): Promise<string | null> {
  const row = await db
    .prepare(`${SPEAKER_CLASH} LIMIT 1`)
    .bind(eventId, submissionId, startsAt, minutes)
    .first<{ clash_id: string }>();
  return row?.clash_id ?? null;
}

/* ------------------------------------------------------------------ *
 * The public address of a session
 * ------------------------------------------------------------------ */

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return base || 'session';
}

/**
 * A session's public address, minted the first time it has a place to be.
 * Two talks in one event can share a title, so a taken address takes a short
 * tail rather than a counter — the address is a name, not a position.
 */
async function mintPublicSlug(db: D1Database, eventId: string, title: string): Promise<string> {
  const base = slugify(title);
  // substr, not LIKE: D1 refuses a bound LIKE pattern much past 50 bytes
  // ("pattern too complex"), and a 60-char title base sails right past that.
  const prefix = `${base}-`;
  const res = await db
    .prepare(
      `SELECT public_slug FROM submission
        WHERE event_id = ?1 AND public_slug IS NOT NULL
          AND (public_slug = ?2 OR substr(public_slug, 1, ?3) = ?4)`
    )
    .bind(eventId, base, prefix.length, prefix)
    .all<{ public_slug: string }>();
  const taken = new Set(res.results.map((r) => r.public_slug));
  let candidate = base;
  for (let i = 0; taken.has(candidate) && i < 8; i++) {
    candidate = `${base}-${newId('s').slice(-4)}`;
  }
  return candidate;
}

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

type PlacementRow = {
  id: string;
  state: string;
  title: string;
  requested_min: number;
  public_slug: string | null;
  starts_at: number | null;
  room_id: string | null;
};

async function sessionRow(
  db: D1Database,
  eventId: string,
  submissionId: string
): Promise<PlacementRow | null> {
  return await db
    .prepare(
      `SELECT id, state, title, requested_min, public_slug, starts_at, room_id
         FROM submission WHERE id = ? AND event_id = ?`
    )
    .bind(submissionId, eventId)
    .first<PlacementRow>();
}

/**
 * Put an accepted talk in a room at a time. First placement mints the public
 * address; a later move keeps it, because a link that has been sent to a
 * speaker must not change under them.
 *
 * The room is the database's business (the overlap trigger) and the people are
 * this batch's (the guard). Both are checked again inside the transaction, so
 * two organizers placing into the same slot at 23:40 cannot both win.
 */
export async function placeSession(
  db: D1Database,
  principal: Principal,
  eventId: string,
  submissionId: string,
  roomId: string,
  startsAt: number
): Promise<AgendaResult> {
  requireScope(principal, eventId, EDIT_ROLES);

  const sub = await sessionRow(db, eventId, submissionId);
  if (!sub) return { ok: false, reason: 'moved' };
  if (sub.state !== 'accepted') return { ok: false, reason: 'not-accepted' };
  if (!Number.isFinite(startsAt)) return { ok: false, reason: 'trouble' };

  const clash = await speakerClash(db, eventId, submissionId, startsAt, sub.requested_min);
  if (clash) return { ok: false, reason: 'speaker-busy', clashId: clash };

  const slug = sub.public_slug ?? (await mintPublicSlug(db, eventId, sub.title));

  try {
    await checkedBatch(
      db,
      [
        guard(db, "SELECT 1 FROM submission WHERE id = ?1 AND state <> 'accepted'", submissionId),
        guard(db, SPEAKER_CLASH, eventId, submissionId, startsAt, sub.requested_min),
        db
          .prepare(
            `UPDATE submission
                SET starts_at = ?2, room_id = ?3, public_slug = COALESCE(public_slug, ?4)
              WHERE id = ?1`
          )
          .bind(submissionId, startsAt, roomId, slug),
      ],
      [0, 0, 1],
      STALE
    );
  } catch (e) {
    return { ok: false, reason: failureOf(e, 'placeSession') };
  }
  return { ok: true };
}

/**
 * Take a talk off the grid. The public address stays with it: it earned one
 * the day it had a room, and a talk that comes back should come back to the
 * same link.
 */
export async function clearPlacement(
  db: D1Database,
  principal: Principal,
  eventId: string,
  submissionId: string
): Promise<AgendaResult> {
  requireScope(principal, eventId, EDIT_ROLES);

  const sub = await sessionRow(db, eventId, submissionId);
  if (!sub) return { ok: false, reason: 'moved' };
  if (sub.starts_at === null && sub.room_id === null) return { ok: false, reason: 'moved' };

  try {
    await checkedBatch(
      db,
      [
        guard(
          db,
          'SELECT 1 FROM submission WHERE id = ?1 AND starts_at IS NULL AND room_id IS NULL',
          submissionId
        ),
        db
          .prepare('UPDATE submission SET starts_at = NULL, room_id = NULL WHERE id = ?1')
          .bind(submissionId),
      ],
      [0, 1],
      STALE
    );
  } catch (e) {
    return { ok: false, reason: failureOf(e, 'clearPlacement') };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Off the program, and back on
 * ------------------------------------------------------------------ */

/**
 * A talk that is not happening any more, in the room it was going to happen
 * in. Cancelled keeps its placement on purpose (01 inv. 2/Δ4): the strike
 * through the line is how somebody standing in the corridor learns not to
 * queue at that door.
 */
export async function cancelSession(
  db: D1Database,
  principal: Principal,
  eventId: string,
  submissionId: string,
  note: string | null
): Promise<AgendaResult> {
  requireScope(principal, eventId, EDIT_ROLES);

  const sub = await sessionRow(db, eventId, submissionId);
  if (!sub) return { ok: false, reason: 'moved' };
  if (sub.state !== 'accepted') return { ok: false, reason: 'not-accepted' };

  const t = now();
  try {
    await checkedBatch(
      db,
      [
        guard(db, "SELECT 1 FROM submission WHERE id = ?1 AND state <> 'accepted'", submissionId),
        db
          .prepare(
            `UPDATE submission SET state = 'cancelled', cancelled_at = ?2, cancel_note = ?3
              WHERE id = ?1 AND state = 'accepted'`
          )
          .bind(submissionId, t, note && note.trim() ? note.trim() : null),
      ],
      [0, 1],
      STALE
    );
  } catch (e) {
    return { ok: false, reason: failureOf(e, 'cancelSession') };
  }
  return { ok: true };
}

/**
 * Put a cancelled session back on. It keeps the time and room it never gave
 * up, so both conflict laws are asked again on the way in — somebody else may
 * have taken that room in the meantime.
 */
export async function restoreSession(
  db: D1Database,
  principal: Principal,
  eventId: string,
  submissionId: string
): Promise<AgendaResult> {
  requireScope(principal, eventId, EDIT_ROLES);

  const sub = await sessionRow(db, eventId, submissionId);
  if (!sub) return { ok: false, reason: 'moved' };
  if (sub.state !== 'cancelled') return { ok: false, reason: 'moved' };

  if (sub.starts_at !== null) {
    const clash = await speakerClash(db, eventId, submissionId, sub.starts_at, sub.requested_min);
    if (clash) return { ok: false, reason: 'speaker-busy', clashId: clash };
  }

  const statements = [
    guard(db, "SELECT 1 FROM submission WHERE id = ?1 AND state <> 'cancelled'", submissionId),
    db
      .prepare(
        `UPDATE submission SET state = 'accepted', cancelled_at = NULL, cancel_note = NULL
          WHERE id = ?1 AND state = 'cancelled'`
      )
      .bind(submissionId),
  ];
  const expect: (number | 'any')[] = [0, 1];
  if (sub.starts_at !== null) {
    statements.splice(1, 0, guard(db, SPEAKER_CLASH, eventId, submissionId, sub.starts_at, sub.requested_min));
    expect.splice(1, 0, 0);
  }

  try {
    await checkedBatch(db, statements, expect, STALE);
  } catch (e) {
    return { ok: false, reason: failureOf(e, 'restoreSession') };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * The public agenda
 * ------------------------------------------------------------------ */

/** What "on the grid" counts as, for the number a person confirms. */
const PLACED_COUNT = `SELECT COUNT(*) FROM submission
   WHERE event_id = ?1 AND starts_at IS NOT NULL AND state IN ('accepted','cancelled')`;

/**
 * Let the public see the program. `expectedPlaced` is the number the organizer
 * read on the confirm ("61 placed sessions become public") — if the grid moved
 * while they were reading it, nothing publishes and they look again. D-024:
 * the number a person confirms is the number that goes.
 */
export async function publishAgenda(
  db: D1Database,
  principal: Principal,
  eventId: string,
  expectedPlaced: number
): Promise<AgendaResult> {
  return await setPublished(db, principal, eventId, expectedPlaced, 1, 'publishAgenda');
}

/** Take it down again. Speakers keep their own times in their portal. */
export async function unpublishAgenda(
  db: D1Database,
  principal: Principal,
  eventId: string,
  expectedPlaced: number
): Promise<AgendaResult> {
  return await setPublished(db, principal, eventId, expectedPlaced, 0, 'unpublishAgenda');
}

async function setPublished(
  db: D1Database,
  principal: Principal,
  eventId: string,
  expectedPlaced: number,
  to: 0 | 1,
  where: string
): Promise<AgendaResult> {
  requireScope(principal, eventId, EDIT_ROLES);

  const state = await db
    .prepare(`SELECT agenda_published, (${PLACED_COUNT}) AS placed FROM event WHERE id = ?1`)
    .bind(eventId)
    .first<{ agenda_published: number; placed: number }>();
  if (!state) return { ok: false, reason: 'moved' };
  if (state.agenda_published === to) return { ok: false, reason: 'moved' };
  if (state.placed !== expectedPlaced) return { ok: false, reason: 'count-moved' };

  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 FROM event WHERE id = ?1 AND agenda_published = ?2', eventId, to),
        guard(db, `SELECT 1 WHERE (${PLACED_COUNT}) <> ?2`, eventId, expectedPlaced),
        db.prepare('UPDATE event SET agenda_published = ?2 WHERE id = ?1').bind(eventId, to),
      ],
      [0, 0, 1],
      STALE
    );
  } catch (e) {
    const reason = failureOf(e, where);
    return { ok: false, reason: reason === 'moved' ? 'count-moved' : reason };
  }
  return { ok: true };
}
