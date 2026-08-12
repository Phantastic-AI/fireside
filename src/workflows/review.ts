// Scoring is the first act; submitting is the second (D-024, R-11).
//
// Staging a review is one click and it is undoable: the row is mine, nobody
// else can read it, and saving it again overwrites it. Submitting is the pass
// that binds — it feeds every aggregate on the proposal screen and it cannot
// be taken back inside the round — so it carries the number the reviewer read
// on the confirm, and a guard that refuses the whole batch when the number
// moved. That is release.ts's law applied one desk over: the number a person
// confirms is the number that goes.
//
// The immutability rule is the round's, not the review's: a submitted review
// is fixed until the committee starts a new round, at which point the same
// reviewer gets a fresh row keyed on the new round number. Nothing here edits
// or deletes a submitted row.

import { checkedBatch, guard, newId, now } from '../lib/db';
import { requireScope, READ_ROLES } from '../queries/admin';
import { MY_STAGED_SQL } from '../queries/reviews';
import type { Principal } from './account';

/**
 * The closed set of things that can happen to a review write. The screen owns
 * the sentences; this file owns only which one is true.
 *
 *   'saved'   — the marks are staged, and still only theirs
 *   'noted'   — the note was kept, but no mark was made, so nothing is staged
 *   'sent'    — the staged cohort went to the committee
 *   'locked'  — already submitted this round; a submitted review is fixed
 *   'gone'    — the proposal is decided, or was never on this event
 *   'blank'   — nothing was marked and nothing written
 *   'nothing' — asked to submit with nothing staged
 *   'moved'   — the pile moved between the reading and the click
 *   'trouble' — something unexpected; nothing was written
 */
export type ReviewOutcome =
  | 'saved'
  | 'noted'
  | 'sent'
  | 'locked'
  | 'gone'
  | 'blank'
  | 'nothing'
  | 'moved'
  | 'trouble';

// Never rendered — checkedBatch wants a string for the StaleStateError it
// throws, and the screen's own words live in routes/admin/reviews.ts.
const STALE = 'the round moved';

function outcomeOf(e: unknown, where: string): ReviewOutcome {
  if (e instanceof Error && (e.name === 'StaleStateError' || e.name === 'ChangesMismatchError')) {
    return 'moved';
  }
  console.error(`${where}: ${String(e)}`);
  return 'trouble';
}

/* ------------------------------------------------------------------ *
 * Staging one review
 * ------------------------------------------------------------------ */

/**
 * Write my marks for one proposal in one round, staged.
 *
 * INSERT OR REPLACE on the (submission, reviewer, round) key, submitted_at
 * always NULL: re-saving is the whole editing story, and there is no second
 * row for the same reviewer in the same round to disagree with the first.
 * The existing row's own id is reused when there is one, so a proposal screen
 * that has already read a review does not find it renamed underneath.
 *
 * `scores` arrives already checked against the round's scorecard — this
 * function is the writer, not the parser.
 */
export async function upsertReview(
  db: D1Database,
  principal: Principal,
  eventId: string,
  round: number,
  submissionId: string,
  scores: Record<string, number>,
  note: string | null
): Promise<ReviewOutcome> {
  requireScope(principal, eventId, READ_ROLES);

  const existing = await db
    .prepare(
      `SELECT rv.id, rv.submitted_at, s.state
         FROM submission s
         LEFT JOIN review rv
           ON rv.submission_id = s.id AND rv.reviewer_person_id = ? AND rv.round = ?
        WHERE s.id = ? AND s.event_id = ?`
    )
    .bind(principal.personId, round, submissionId, eventId)
    .first<{ id: string | null; submitted_at: number | null; state: string }>();

  // Not on this event, or decided since the queue was read: there is nothing
  // left to score, and saying so is kinder than writing a mark nobody counts.
  if (!existing || existing.state !== 'submitted') return 'gone';
  if (existing.submitted_at !== null) return 'locked';

  const marked = Object.keys(scores).length > 0;
  const written = (note ?? '').trim();
  // Nothing marked, nothing written, and no row to clear: an empty save is not
  // an act. Once a row exists, an empty save is how a reviewer takes it back.
  if (!marked && !written && existing.id === null) return 'blank';

  try {
    await checkedBatch(
      db,
      [
        guard(
          db,
          `SELECT 1 FROM submission s
            WHERE s.id = ?1
              AND (s.event_id <> ?2 OR s.state <> 'submitted'
                   OR EXISTS (SELECT 1 FROM review rv
                               WHERE rv.submission_id = s.id
                                 AND rv.reviewer_person_id = ?3 AND rv.round = ?4
                                 AND rv.submitted_at IS NOT NULL))`,
          submissionId,
          eventId,
          principal.personId,
          round
        ),
        db
          .prepare(
            `INSERT OR REPLACE INTO review
               (id, submission_id, reviewer_person_id, round, scores, note, submitted_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL)`
          )
          .bind(
            existing.id ?? newId('rev'),
            submissionId,
            principal.personId,
            round,
            JSON.stringify(scores),
            written ? written : null
          ),
      ],
      // REPLACE may report the row it displaced as well as the row it wrote,
      // so the assertion is "at least one", not "exactly one".
      [0, { atLeast: 1 }],
      STALE
    );
  } catch (e) {
    return outcomeOf(e, 'upsertReview');
  }
  // A note without a mark is kept — a reviewer thinking out loud is doing the
  // work — but it is not staged, because MY_STAGED_SQL counts marks. Saying
  // "nothing was staged" over a note that was in fact saved would be a lie.
  return marked ? 'saved' : written ? 'noted' : 'blank';
}

/* ------------------------------------------------------------------ *
 * Submitting the staged cohort
 * ------------------------------------------------------------------ */

/**
 * The cohort: my staged reviews for this round, on proposals still undecided
 * on this event. Identical, clause for clause, to what queries/reviews.ts
 * counts on the masthead and lists on the confirm — the arithmetic a reviewer
 * reads is the arithmetic that runs.
 */
const COHORT = `SELECT rv.id AS review_id
   FROM review rv
   JOIN submission s ON s.id = rv.submission_id
  WHERE s.event_id = ?1 AND s.state = 'submitted'
    AND rv.reviewer_person_id = ?2 AND rv.round = ?3
    AND ${MY_STAGED_SQL}`;

export type SubmitResult =
  | { outcome: 'sent'; submitted: number }
  | { outcome: Exclude<ReviewOutcome, 'sent'>; submitted: 0 };

/**
 * Submit exactly `expectedCount` staged reviews, or none at all.
 *
 * One set-based update behind one guard. If a proposal was decided, or another
 * tab staged a ninth review, between the confirm and the click, the count no
 * longer matches, the guard's CHECK-violating row aborts the batch, and the
 * screen asks the reviewer to look again. Nothing partial ever lands.
 */
export async function submitReviews(
  db: D1Database,
  principal: Principal,
  eventId: string,
  round: number,
  expectedCount: number,
  nowMs: number = now()
): Promise<SubmitResult> {
  requireScope(principal, eventId, READ_ROLES);
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    return { outcome: 'nothing', submitted: 0 };
  }

  try {
    await checkedBatch(
      db,
      [
        guard(
          db,
          `SELECT 1 WHERE (SELECT COUNT(*) FROM (${COHORT})) <> ?4`,
          eventId,
          principal.personId,
          round,
          expectedCount
        ),
        db
          .prepare(
            `UPDATE review SET submitted_at = ?4
              WHERE id IN (SELECT review_id FROM (${COHORT}))`
          )
          .bind(eventId, principal.personId, round, nowMs),
      ],
      [0, expectedCount],
      STALE
    );
  } catch (e) {
    return { outcome: outcomeOf(e, 'submitReviews'), submitted: 0 };
  }
  return { outcome: 'sent', submitted: expectedCount };
}
