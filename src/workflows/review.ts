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
import { MY_STAGED_SQL, UNTOUCHED_SQL } from '../queries/reviews';
import { requireDecider } from './decide';
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

/* ------------------------------------------------------------------ *
 * Handing the pile out
 * ------------------------------------------------------------------ */

/**
 * The closed set of things that can happen to a hand-out. Same discipline as
 * ReviewOutcome: this file owns which one is true, the screen owns the words.
 *
 *   'handed'  — assignments were made; the counts come back with it
 *   'nobody'  — no reader was chosen, or none of the chosen can read here
 *   'nothing' — every undecided proposal already has the readers she asked for
 *   'freed'   — untouched assignments came back off somebody's list
 *   'kept'    — nothing came back, because everything they hold has work in it
 *   'moved'   — the round or the numbers moved between the reading and the click
 *   'trouble' — something unexpected; nothing was written
 */
export type AssignOutcome =
  | 'handed'
  | 'nobody'
  | 'nothing'
  | 'freed'
  | 'kept'
  | 'moved'
  | 'trouble';

/**
 * One click reaches this far down the pile — the longest-waiting proposals
 * first. It is a ceiling on one transaction, not on the work: a call bigger
 * than this wants the round split, and the outcome sentence says as much
 * rather than pretending the rest were handed out.
 */
export const HANDOUT_CAP = 1000;
/** More readers than this in one pass is a committee, not a hand-out. */
export const MOST_READERS = 12;
/** Nobody reads a proposal more than three times before the room talks. */
export const MOST_EACH = 3;

export type HandOut = {
  outcome: AssignOutcome;
  /** Rows written. */
  handed: number;
  /** Pairs that were already in that reader's hands, so nothing was written. */
  held: number;
  /** True when the pile is longer than one pass can carry. */
  more: boolean;
};

/**
 * The undecided pile, indexed in the queue's own order.
 *
 * `i` is what makes the round-robin set-based: proposal i goes to readers
 * i, i+1 … i+n-1 modulo the number chosen, so one statement per reader hands
 * out the whole pile without a loop, a temporary table, or a thousand round
 * trips at midnight.
 *
 * THE INDEX MUST NOT MOVE WHILE THE BATCH RUNS. An earlier draft narrowed this
 * to "proposals with fewer than n readers", which reads well and is wrong: the
 * statements run in order inside one transaction, so the second reader's
 * shortlist had already lost everything the first reader took, the numbering
 * shifted under it, and three readers finished holding 25, 17 and 5. Ordering
 * on submission facts alone — which no statement here writes — is what makes
 * every reader's share the same size and makes `held` exact arithmetic rather
 * than an estimate.
 */
const PILE_INDEXED = `SELECT s.id AS id,
          ROW_NUMBER() OVER (ORDER BY s.submitted_at IS NULL, s.submitted_at, s.id) - 1 AS i
     FROM submission s
    WHERE s.event_id = ?1 AND s.state = 'submitted'`;

/**
 * Give every undecided proposal to `each` of the readers chosen, spread
 * round-robin so nobody carries the evening alone.
 *
 * ONE CLICK, and the law says so: this is backstage, private, and undoable —
 * an assignment holds nobody's work until somebody writes in it, and the
 * take-back below undoes exactly the ones nobody has. Nothing leaves the
 * building, no speaker learns anything, no average moves. What the two-pass
 * rule asks of an act this size is that the screen name the number, which the
 * outcome sentence does: "312 handed out. 16 were already held."
 *
 * Existing pairs are skipped rather than overwritten (the NOT EXISTS), which
 * makes the whole act idempotent: run it twice with the same answer and the
 * second run writes nothing and says so. `held` is exact rather than
 * estimated — every slot the distribution intended either became a row or was
 * already that reader's, and the difference between the two is the number the
 * sentence reports.
 */
export async function handOutAssignments(
  db: D1Database,
  principal: Principal,
  eventId: string,
  round: number,
  readerIds: string[],
  each: number
): Promise<HandOut> {
  requireDecider(principal, eventId);

  const none: HandOut = { outcome: 'nobody', handed: 0, held: 0, more: false };
  const per = Math.floor(each);
  if (!Number.isInteger(per) || per < 1 || per > MOST_EACH) return none;

  const wanted = [...new Set(readerIds.filter((id) => id.trim() !== ''))].slice(0, MOST_READERS);
  if (wanted.length === 0) return none;

  // Only people who can already read this event's proposals may be handed one.
  // Checked here so an unknown name is quietly dropped, and checked again in
  // the batch so a standing withdrawn mid-click takes the whole thing down.
  const eligible = await db
    .prepare(
      `SELECT p.id FROM person p
        WHERE p.id IN (${wanted.map(() => '?').join(',')})
          AND (p.internal_role = 'organizer'
               OR EXISTS (SELECT 1 FROM event_role er
                           WHERE er.event_id = ? AND er.person_id = p.id))`
    )
    .bind(...wanted, eventId)
    .all<{ id: string }>();
  const readers = eligible.results.map((r) => r.id);
  if (readers.length === 0) return none;

  const pile = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM submission s
        WHERE s.event_id = ?1 AND s.state = 'submitted'`
    )
    .bind(eventId)
    .first<{ n: number }>();
  const undecided = pile?.n ?? 0;
  if (undecided === 0) return { outcome: 'nothing', handed: 0, held: 0, more: false };

  const k = readers.length;
  const reach = Math.min(undecided, HANDOUT_CAP);
  const intended = reach * Math.min(per, k);

  const statements = [
    guard(db, 'SELECT 1 FROM event WHERE id = ?1 AND current_round <> ?2', eventId, round),
    guard(
      db,
      `SELECT 1 FROM person p
        WHERE p.id IN (${readers.map(() => '?').join(',')})
          AND p.internal_role IS NOT 'organizer'
          AND NOT EXISTS (SELECT 1 FROM event_role er
                           WHERE er.event_id = ? AND er.person_id = p.id)`,
      ...readers,
      eventId
    ),
    // One statement per reader: their slice of the round-robin, minus whatever
    // is already in their hands. The id is drawn per row, because a batch of
    // six hundred rows cannot share one.
    ...readers.map((reader, j) =>
      db
        .prepare(
          `INSERT INTO review (id, submission_id, reviewer_person_id, round, scores, note, submitted_at)
           SELECT 'rev-' || lower(hex(randomblob(6))), q.id, ?3, ?2, '{}', NULL, NULL
             FROM (${PILE_INDEXED}) q
            WHERE q.i < ?4
              AND ((?5 - q.i) % ?6 + ?6) % ?6 < ?7
              AND NOT EXISTS (SELECT 1 FROM review rv
                               WHERE rv.submission_id = q.id
                                 AND rv.reviewer_person_id = ?3 AND rv.round = ?2)`
        )
        .bind(eventId, round, reader, HANDOUT_CAP, j, k, Math.min(per, k))
    ),
  ];

  let results;
  try {
    results = await checkedBatch(
      db,
      statements,
      [0, 0, ...readers.map(() => 'any' as const)],
      STALE
    );
  } catch (e) {
    const outcome = outcomeOf(e, 'handOutAssignments');
    return { outcome: outcome === 'moved' ? 'moved' : 'trouble', handed: 0, held: 0, more: false };
  }

  const handed = results
    .slice(2)
    .reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  const held = Math.max(0, intended - handed);
  const more = undecided > reach;
  return { outcome: handed > 0 ? 'handed' : 'nothing', handed, held, more };
}

/**
 * Take back the assignments one reader has not written in.
 *
 * The refusal is structural rather than polite: the cohort below is
 * UNTOUCHED_SQL, so a staged review and a submitted one are not eligible to be
 * deleted by anybody, ever. `expected` is the number the chair read on the
 * button, and the guard refuses the whole batch if it moved — if that reader
 * scored one of them in the last half-second, nothing comes back and the
 * screen says so rather than quietly taking one fewer.
 */
const UNTOUCHED_COHORT = `SELECT rv.id AS review_id
   FROM review rv
   JOIN submission s ON s.id = rv.submission_id
  WHERE s.event_id = ?1 AND s.state = 'submitted'
    AND rv.reviewer_person_id = ?2 AND rv.round = ?3
    AND ${UNTOUCHED_SQL}`;

export async function takeBackAssignments(
  db: D1Database,
  principal: Principal,
  eventId: string,
  round: number,
  personId: string,
  expectedCount: number
): Promise<{ outcome: AssignOutcome; freed: number }> {
  requireDecider(principal, eventId);
  if (!personId || !Number.isInteger(expectedCount) || expectedCount < 1) {
    return { outcome: 'kept', freed: 0 };
  }

  try {
    await checkedBatch(
      db,
      [
        guard(
          db,
          `SELECT 1 WHERE (SELECT COUNT(*) FROM (${UNTOUCHED_COHORT})) <> ?4`,
          eventId,
          personId,
          round,
          expectedCount
        ),
        db
          .prepare(`DELETE FROM review WHERE id IN (SELECT review_id FROM (${UNTOUCHED_COHORT}))`)
          .bind(eventId, personId, round),
      ],
      [0, expectedCount],
      STALE
    );
  } catch (e) {
    const outcome = outcomeOf(e, 'takeBackAssignments');
    return { outcome: outcome === 'moved' ? 'moved' : 'trouble', freed: 0 };
  }
  return { outcome: 'freed', freed: expectedCount };
}
