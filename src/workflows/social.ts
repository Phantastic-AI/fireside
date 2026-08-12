// Δ12 — the four writes an audience member owns: starring, adopting the list
// this browser was keeping for them, choosing to share it, and noting someone
// they mean to find.
//
// Standing: an audience member has standing on exactly one row — their own
// my_schedule for this event — and on nothing else in the building. So every
// statement here carries person_id AND event_id in its own WHERE clause, and
// every batch opens with a guard that fires if the schedule being touched is
// not theirs. Neither trusts the caller; the caller has already proved who it
// is, and the SQL proves it again.
//
// Two more rules the schema and this file hold together:
//   - a star may only name a session a stranger could already see (accepted or
//     cancelled, placed, on a published agenda). The INSERT joins that rule in,
//     so a fabricated id inserts nothing rather than something invisible;
//   - shared_at is set on write, per star, and only while sharing is on. It is
//     what the reciprocity join reads — see queries/social.ts.
//
// Outcome words are the portal's four, minus the one that cannot happen here
// (no state-transition trigger governs a star). The screen owns the sentences.

import { checkedBatch, guard, newId, now, ChangesMismatchError, StaleStateError } from '../lib/db';
import type { ContactOptIns } from '../queries/social';

/**
 * What happened, in three words routes/public/schedule.ts knows how to say:
 *   'done'    — it landed
 *   'moved'   — something changed under them; nothing was written
 *   'trouble' — unexpected; nothing was written
 */
export type SocialOutcome = 'done' | 'moved' | 'trouble';

// Never rendered — checkedBatch wants a message for its StaleStateError.
const STALE = 'the list moved';

function outcomeOf(e: unknown, where: string): SocialOutcome {
  if (e instanceof StaleStateError) return 'moved';
  if (e instanceof ChangesMismatchError) return 'moved';
  console.error(`${where}: ${String(e)}`);
  return 'trouble';
}

/** Fires when the schedule row exists and belongs to someone else, or to
 *  another event. Every batch below opens with it. */
const NOT_MINE = 'SELECT 1 FROM my_schedule WHERE id = ? AND (person_id <> ? OR event_id <> ?)';

/* ------------------------------------------------------------------ *
 * The row itself, made on first use
 * ------------------------------------------------------------------ */

/**
 * Find-or-create this person's schedule for this event. Nothing exists until
 * they act: a signed-in visitor who has never starred anything owns no row, and
 * the page says so without one. The INSERT is conditional on its own absence
 * and the table's UNIQUE (person_id, event_id) is the final word, so two tabs
 * racing produce one row and one winner.
 */
export async function ensureSchedule(
  db: D1Database,
  personId: string,
  eventId: string,
  nowMs: number = now()
): Promise<string | null> {
  const found = await db
    .prepare('SELECT id FROM my_schedule WHERE person_id = ? AND event_id = ?')
    .bind(personId, eventId)
    .first<{ id: string }>();
  if (found) return found.id;

  const id = newId('sch');
  try {
    await checkedBatch(
      db,
      [
        db
          .prepare(
            `INSERT INTO my_schedule (id, person_id, event_id, share_nonce, share_enabled, created_at, updated_at)
             SELECT ?, ?, ?, NULL, 0, ?, ?
              WHERE EXISTS (SELECT 1 FROM event WHERE id = ?)
                AND NOT EXISTS (SELECT 1 FROM my_schedule WHERE person_id = ? AND event_id = ?)`
          )
          .bind(id, personId, eventId, nowMs, nowMs, eventId, personId, eventId),
      ],
      ['any'],
      STALE
    );
  } catch (e) {
    console.error(`ensureSchedule: ${String(e)}`);
  }
  const row = await db
    .prepare('SELECT id FROM my_schedule WHERE person_id = ? AND event_id = ?')
    .bind(personId, eventId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/* ------------------------------------------------------------------ *
 * Starring
 * ------------------------------------------------------------------ */

// One statement that is its own guard: it inserts only when the session is
// theirs to star (same event), publicly visible, and not already starred. A
// star made while sharing is on is shared the moment it is made — that is what
// "on" means, and it is why shared_at is computed here rather than remembered.
const STAR_INSERT = `
  INSERT INTO star (id, my_schedule_id, submission_id, starred_at, shared_at)
  SELECT ?, ms.id, s.id, ?, CASE WHEN ms.share_enabled = 1 THEN ? END
    FROM my_schedule ms
    JOIN submission s ON s.id = ?
    JOIN event e ON e.id = s.event_id
   WHERE ms.id = ? AND ms.person_id = ? AND ms.event_id = ?
     AND s.event_id = ms.event_id
     AND s.state IN ('accepted','cancelled') AND s.starts_at IS NOT NULL
     AND e.agenda_published = 1
     AND NOT EXISTS (SELECT 1 FROM star x
                      WHERE x.my_schedule_id = ms.id AND x.submission_id = s.id)`;

/**
 * Star or unstar one session. One click, theirs alone, undoable by the same
 * click — D-024's first half, so there is no confirmation anywhere near it.
 */
export async function setStar(
  db: D1Database,
  personId: string,
  eventId: string,
  submissionId: string,
  on: boolean,
  nowMs: number = now()
): Promise<SocialOutcome> {
  const scheduleId = await ensureSchedule(db, personId, eventId, nowMs);
  if (!scheduleId) return 'trouble';
  try {
    await checkedBatch(
      db,
      [
        guard(db, NOT_MINE, scheduleId, personId, eventId),
        on
          ? db
              .prepare(STAR_INSERT)
              .bind(newId('str'), nowMs, nowMs, submissionId, scheduleId, personId, eventId)
          : db
              .prepare(
                `DELETE FROM star
                  WHERE my_schedule_id = ? AND submission_id = ?
                    AND EXISTS (SELECT 1 FROM my_schedule ms
                                 WHERE ms.id = star.my_schedule_id
                                   AND ms.person_id = ? AND ms.event_id = ?)`
              )
              .bind(scheduleId, submissionId, personId, eventId),
      ],
      [0, 'any'],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'setStar');
  }
}

/* ------------------------------------------------------------------ *
 * Adopting what the browser was keeping
 * ------------------------------------------------------------------ */

/** Above this many at once it is not a person's list any more. */
const ADOPT_LIMIT = 80;

/**
 * Take the stars this browser has been holding and put them on their list.
 *
 * One batch: the ownership guard, then one INSERT-missing per id — the same
 * self-guarding statement `setStar` uses, so an id that is not a visible
 * session of this event inserts nothing and costs nothing. `kept` is the sum of
 * the rows actually written, which is what the page then says out loud; ids
 * they had already starred contribute zero, so a repeat lands as "nothing new"
 * rather than as a lie.
 */
export async function adoptStars(
  db: D1Database,
  personId: string,
  eventId: string,
  submissionIds: string[],
  nowMs: number = now()
): Promise<{ outcome: SocialOutcome; kept: number }> {
  const ids = [...new Set(submissionIds.filter((s) => s !== ''))].slice(0, ADOPT_LIMIT);
  if (!ids.length) return { outcome: 'done', kept: 0 };

  const scheduleId = await ensureSchedule(db, personId, eventId, nowMs);
  if (!scheduleId) return { outcome: 'trouble', kept: 0 };

  try {
    const results = await checkedBatch(
      db,
      [
        guard(db, NOT_MINE, scheduleId, personId, eventId),
        ...ids.map((id) =>
          db.prepare(STAR_INSERT).bind(newId('str'), nowMs, nowMs, id, scheduleId, personId, eventId)
        ),
      ],
      [0, ...ids.map(() => 'any' as const)],
      STALE
    );
    const kept = results.slice(1).reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
    return { outcome: 'done', kept };
  } catch (e) {
    return { outcome: outcomeOf(e, 'adoptStars'), kept: 0 };
  }
}

/* ------------------------------------------------------------------ *
 * The share choice
 * ------------------------------------------------------------------ */

/**
 * Turn sharing on or off, and record what may be seen while it is on.
 *
 * Set-based on purpose: enabling stamps shared_at on every star that does not
 * have one, disabling clears every shared_at outright. There is no third state
 * and no per-star bookkeeping — sharing is one decision about one list, and
 * because the reciprocity join reads both share_enabled and shared_at, turning
 * it off empties other people's view of you on their next page load.
 *
 * The contact opt-ins ride the same act: name is always visible, work, links
 * and address are three separate yeses, all defaulting to no (02 §1.21).
 */
export async function setSharing(
  db: D1Database,
  personId: string,
  eventId: string,
  on: boolean,
  contact: ContactOptIns,
  nowMs: number = now()
): Promise<SocialOutcome> {
  const scheduleId = await ensureSchedule(db, personId, eventId, nowMs);
  if (!scheduleId) return 'trouble';

  const statements = [
    guard(db, NOT_MINE, scheduleId, personId, eventId),
    db
      .prepare('UPDATE my_schedule SET share_enabled = ?, updated_at = ? WHERE id = ? AND person_id = ?')
      .bind(on ? 1 : 0, nowMs, scheduleId, personId),
    on
      ? db
          .prepare('UPDATE star SET shared_at = ? WHERE my_schedule_id = ? AND shared_at IS NULL')
          .bind(nowMs, scheduleId)
      : db.prepare('UPDATE star SET shared_at = NULL WHERE my_schedule_id = ?').bind(scheduleId),
  ];
  const expect: (number | 'any')[] = [0, 1, 'any'];
  if (on) {
    statements.push(
      db
        .prepare('UPDATE person SET share_contact = ? WHERE id = ?')
        .bind(
          JSON.stringify({ work: contact.work, links: contact.links, email: contact.email }),
          personId
        )
    );
    expect.push(1);
  }

  try {
    await checkedBatch(db, statements, expect, STALE);
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'setSharing');
  }
}

/* ------------------------------------------------------------------ *
 * Noting someone to find
 * ------------------------------------------------------------------ */

const NOTE_LIMIT = 280;

// The connection may only be made where the overlap really is: my shared star,
// their shared star, on the same session, with both of us sharing. Same six
// conditions as the read, so a note can never be attached to someone who is not
// on the list — including someone who was on it a second ago and has since
// turned sharing off.
const RECIPROCAL = `
  SELECT 1
    FROM my_schedule ms
    JOIN star mine ON mine.my_schedule_id = ms.id
                  AND mine.submission_id = ? AND mine.shared_at IS NOT NULL
    JOIN my_schedule other ON other.event_id = ms.event_id
                  AND other.person_id = ? AND other.share_enabled = 1
    JOIN star theirs ON theirs.my_schedule_id = other.id
                  AND theirs.submission_id = mine.submission_id
                  AND theirs.shared_at IS NOT NULL
   WHERE ms.person_id = ? AND ms.event_id = ? AND ms.share_enabled = 1`;

/**
 * Note someone you mean to find, against the session you are both going to.
 * One per person per session (the table's own UNIQUE), INSERT-missing: a second
 * note about the same talk is not a second person to find, so the first one
 * stands and the row you can already read stays as you wrote it.
 */
export async function noteConnection(
  db: D1Database,
  personId: string,
  eventId: string,
  otherPersonId: string,
  submissionId: string,
  note: string,
  nowMs: number = now()
): Promise<SocialOutcome> {
  if (!otherPersonId || !submissionId || otherPersonId === personId) return 'moved';
  const text = note.trim().slice(0, NOTE_LIMIT);
  try {
    await checkedBatch(
      db,
      [
        guard(
          db,
          `SELECT 1 WHERE NOT EXISTS (${RECIPROCAL})`,
          submissionId,
          otherPersonId,
          personId,
          eventId
        ),
        db
          .prepare(
            `INSERT INTO connection (id, owner_person_id, other_person_id, submission_id, note, created_at)
             SELECT ?, ?, ?, ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM connection
                                 WHERE owner_person_id = ? AND other_person_id = ?
                                   AND submission_id = ?)`
          )
          .bind(
            newId('con'),
            personId,
            otherPersonId,
            submissionId,
            text === '' ? null : text,
            nowMs,
            personId,
            otherPersonId,
            submissionId
          ),
      ],
      [0, 'any'],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'noteConnection');
  }
}
