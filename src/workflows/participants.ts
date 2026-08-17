// Correcting a proposal's cast after a decision — the gap fresh-eyes flagged
// (scoreboard-2026-08-12.md, ABS cluster, minor defect): a speaker's own edit
// form is deliberately locked once the committee has acted (workflows/edit.ts
// guards on `state IN ('draft','submitted')`, on purpose — a decided proposal
// is not the speaker's to keep changing). But a name still gets misspelled, a
// co-presenter still drops out, after the letter has gone, and nobody in the
// product could fix it. This file is the organizer's own door for exactly
// that: no state guard at all, because correcting the cast is the chair's
// call to make regardless of where the proposal stands.
//
// It reuses workflows/submit.ts's own machinery rather than re-deriving it —
// readCoPresenters for the one validation rule (a name, a real-looking
// address), planCoPresenters for find-or-create by address, coParticipation
// for the row itself — so "who counts as already on the talk" and "what makes
// an address good enough" stay one true answer, read here rather than
// restated.
//
// Two acts, both one click: adding a co-presenter and taking one off. Neither
// binds a decision or moves an average, so neither needs D-024's second pass
// — the same reasoning stepAside and saveRoundConfig give for their own
// single-confirm acts elsewhere in this parcel.

import { ChangesMismatchError, StaleStateError, checkedBatch, guard, now, type Expected } from '../lib/db';
import { requireScope, EDIT_ROLES } from '../queries/admin';
import {
  coParticipation,
  peopleOnTalk,
  planCoPresenters,
  readCoPresenters,
  type CoRow,
  type OnTheTalk,
} from './submit';
import type { Principal } from './account';

export type ParticipantsOutcome =
  | { ok: true }
  /** A sentence for the form to say, and the field it is about — same shape
   *  workflows/edit.ts already uses for its own refusals. */
  | { ok: false; kind: 'refused'; field: string | null; message: string }
  | { ok: false; kind: 'moved' }
  | { ok: false; kind: 'trouble' };

const STALE = 'the proposal moved while you were looking';

/** Who is on a proposal right now, submitter first — the read the edit page
 *  and both writers below all share, so nobody drifts from what is on record. */
export async function castOf(
  db: D1Database,
  principal: Principal,
  eventId: string,
  submissionId: string
): Promise<OnTheTalk[] | null> {
  requireScope(principal, eventId, EDIT_ROLES);
  const on = await peopleOnTalk(db, submissionId);
  const scoped = await db
    .prepare('SELECT 1 FROM submission WHERE id = ? AND event_id = ?')
    .bind(submissionId, eventId)
    .first();
  return scoped ? on : null;
}

/**
 * Add one co-presenter, whatever the proposal's decision. Find-or-create by
 * address (planCoPresenters), then one participation row — the same two
 * statements workflows/edit.ts writes for a speaker's own arrivals, minus the
 * open-call and undecided guards that file exists to hold.
 */
export async function addCoPresenter(
  db: D1Database,
  principal: Principal,
  eventId: string,
  submissionId: string,
  row: CoRow,
  nowMs: number = now()
): Promise<ParticipantsOutcome> {
  requireScope(principal, eventId, EDIT_ROLES);

  const onIt = await peopleOnTalk(db, submissionId);
  const reading = readCoPresenters([row], onIt.map((p) => p.email ?? ''));
  if (!reading.ok) return { ok: false, kind: 'refused', field: reading.field, message: reading.message };
  if (reading.fresh.length === 0) {
    return {
      ok: false,
      kind: 'refused',
      field: 'f-co-email',
      message: 'That address is already on this proposal.',
    };
  }

  const plans = await planCoPresenters(db, reading.fresh, nowMs);
  const plan = plans[0];
  if (!plan) return { ok: false, kind: 'trouble' };
  const nextPosition = onIt.length + 1;

  const statements = [
    guard(db, 'SELECT 1 FROM submission s WHERE s.id = ?1 AND s.event_id <> ?2', submissionId, eventId),
  ];
  const expect: Expected[] = [0];
  if (plan.create) {
    statements.push(plan.create);
    expect.push(1);
  }
  statements.push(
    coParticipation(db, submissionId, plan.personId, nextPosition, reading.fresh[0]?.role)
  );
  expect.push(1);

  try {
    await checkedBatch(db, statements, expect, STALE);
  } catch (e) {
    if (e instanceof StaleStateError) return { ok: false, kind: 'moved' };
    console.error(`addCoPresenter: ${String(e)}`);
    return { ok: false, kind: 'trouble' };
  }
  return { ok: true };
}

/**
 * Take one co-presenter off. Scoped in the statement itself to a co-speaker's
 * own row — `role <> 'speaker' AND is_submitter = 0` — so this can never
 * reach the row that says whose proposal it is, whatever id is posted.
 */
export async function removeCoPresenter(
  db: D1Database,
  principal: Principal,
  eventId: string,
  submissionId: string,
  personId: string
): Promise<ParticipantsOutcome> {
  requireScope(principal, eventId, EDIT_ROLES);
  if (!personId) return { ok: false, kind: 'refused', field: null, message: 'Nobody was chosen.' };

  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 FROM submission s WHERE s.id = ?1 AND s.event_id <> ?2', submissionId, eventId),
        db
          .prepare(
            `DELETE FROM participation
              WHERE submission_id = ?1 AND person_id = ?2
                AND role <> 'speaker' AND is_submitter = 0`
          )
          .bind(submissionId, personId),
      ],
      [0, { atLeast: 1 }],
      STALE
    );
  } catch (e) {
    if (e instanceof StaleStateError) return { ok: false, kind: 'moved' };
    if (e instanceof ChangesMismatchError) {
      return {
        ok: false,
        kind: 'refused',
        field: null,
        message: 'That person is not a co-presenter on this proposal, so there is nothing to remove.',
      };
    }
    console.error(`removeCoPresenter: ${String(e)}`);
    return { ok: false, kind: 'trouble' };
  }
  return { ok: true };
}
