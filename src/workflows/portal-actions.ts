// The two writes a speaker owns: marking a task done, and pulling a proposal
// back. Both are scoped to the person doing them — a speaker has standing on
// nothing but their own row, so ownership is written into the SQL rather than
// trusted to the caller (the same discipline queries/portal.ts uses on read).
//
// Every write goes through checkedBatch + guard: the guard fires when the
// precondition has gone stale and aborts the whole batch atomically, and the
// per-statement changes assertion catches the case where a row moved between
// the guard and the update. Neither returns a stack trace to a screen — the
// outcome is a small closed vocabulary and the *screen* owns the sentence.

import { checkedBatch, guard, ChangesMismatchError, StaleStateError } from '../lib/db';

/**
 * What happened, in four words the portal knows how to say:
 *   'done'     — it landed
 *   'moved'    — the thing had already changed under them
 *   'refused'  — the database itself said no (the transition trigger)
 *   'trouble'  — something unexpected; nothing was written
 */
export type WriteOutcome = 'done' | 'moved' | 'refused' | 'trouble';

// Never rendered. checkedBatch wants a message for the StaleStateError it
// throws; the screen's own words live in routes/public/portal.ts.
const STALE = 'precondition moved';

function outcomeOf(e: unknown, where: string): WriteOutcome {
  if (e instanceof StaleStateError) return 'moved';
  if (e instanceof ChangesMismatchError) return 'moved';
  // A BEFORE UPDATE trigger refusing an illegal state change (schema/0001).
  if (/illegal transition/i.test(String(e))) return 'refused';
  console.error(`${where}: ${String(e)}`);
  return 'trouble';
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

// Theirs, and still open. A cancelled task cannot be completed, and completing
// a completed task is not an act — both are 'moved', not a silent success.
const MY_OPEN_TASK = `
  SELECT 1 FROM task
   WHERE id = ? AND person_id = ?
     AND completed_at IS NULL AND cancelled_at IS NULL`;

// Theirs, and actually done. The undo of completeTask: only a task that is
// completed (and not cancelled) can be put back on the list.
const MY_DONE_TASK = `
  SELECT 1 FROM task
   WHERE id = ? AND person_id = ?
     AND completed_at IS NOT NULL AND cancelled_at IS NULL`;

/**
 * Put a completed task back on this person's list — the undo of completeTask.
 * Only theirs, only one that is actually done. A file_request completed by a
 * real deck upload can be reopened too; the deck row stays in place, so this is
 * "back on your list", never "un-sent".
 */
export async function reopenTask(
  db: D1Database,
  personId: string,
  taskId: string
): Promise<WriteOutcome> {
  try {
    await checkedBatch(
      db,
      [
        guard(db, `SELECT 1 WHERE NOT EXISTS (${MY_DONE_TASK})`, taskId, personId),
        db
          .prepare(
            `UPDATE task SET completed_at = NULL
              WHERE id = ? AND person_id = ?
                AND completed_at IS NOT NULL AND cancelled_at IS NULL`
          )
          .bind(taskId, personId),
      ],
      [0, 1],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'reopenTask');
  }
}

/**
 * Mark one of this person's open tasks done. Only theirs, only while open.
 */
export async function completeTask(
  db: D1Database,
  personId: string,
  taskId: string,
  nowMs: number = Date.now()
): Promise<WriteOutcome> {
  try {
    await checkedBatch(
      db,
      [
        guard(db, `SELECT 1 WHERE NOT EXISTS (${MY_OPEN_TASK})`, taskId, personId),
        db
          .prepare(
            `UPDATE task SET completed_at = ?
              WHERE id = ? AND person_id = ?
                AND completed_at IS NULL AND cancelled_at IS NULL`
          )
          .bind(nowMs, taskId, personId),
      ],
      [0, 1],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'completeTask');
  }
}

/* ------------------------------------------------------------------ *
 * Withdrawing
 * ------------------------------------------------------------------ */

// Pre-publication only. A speaker may pull a proposal back while it is with
// the committee, while it is a maybe, and after an acceptance that the public
// has not yet been told about. Once their talk is on a published agenda,
// removing it is the organizer's act (a cancellation, which keeps the slot
// visible and struck through — 01 inv. 2/Δ4), not a speaker's.
//
// The state list is the withdrawable half of trg_submission_transition; the
// trigger remains the final word, and its refusal is surfaced as 'refused'.
const WITHDRAWABLE = `
  SELECT 1 FROM submission s
    JOIN event e ON e.id = s.event_id
    JOIN participation pa ON pa.submission_id = s.id AND pa.person_id = ?
   WHERE s.id = ?
     AND s.state IN ('submitted','waitlisted','accepted')
     AND NOT (e.agenda_published = 1 AND s.starts_at IS NOT NULL)`;

/**
 * Pull one of this person's proposals back.
 *
 * Time and room are cleared with the same statement: the schema holds that
 * placement belongs to accepted-or-cancelled talks only, so a withdrawn row
 * that kept its room would fail its own CHECK. Open tasks hanging off the
 * proposal are cancelled in the same batch — the work they asked for is moot
 * the moment the talk leaves, and a to-do list that keeps asking is a lie.
 */
export async function withdrawProposal(
  db: D1Database,
  personId: string,
  submissionId: string,
  nowMs: number = Date.now()
): Promise<WriteOutcome> {
  try {
    await checkedBatch(
      db,
      [
        guard(db, `SELECT 1 WHERE NOT EXISTS (${WITHDRAWABLE})`, personId, submissionId),
        db
          .prepare(
            `UPDATE submission
                SET state = 'withdrawn', starts_at = NULL, room_id = NULL
              WHERE id = ?
                AND state IN ('submitted','waitlisted','accepted')
                AND EXISTS (SELECT 1 FROM participation pa
                             WHERE pa.submission_id = submission.id AND pa.person_id = ?)`
          )
          .bind(submissionId, personId),
        db
          .prepare(
            `UPDATE task SET cancelled_at = ?, cancel_reason = 'manual'
              WHERE submission_id = ? AND completed_at IS NULL AND cancelled_at IS NULL`
          )
          .bind(nowMs, submissionId),
      ],
      [0, 1, 'any'],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'withdrawProposal');
  }
}
