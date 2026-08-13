// The two writes a speaker owns about their own helpers: adding one, letting
// one go. Both are scoped to the speaker doing them — ownership is written
// into the SQL, never trusted to the caller, the same discipline
// workflows/portal-actions.ts and workflows/friends.ts already keep.
//
// Finding or making the helper's own person row mirrors workflows/submit.ts's
// planCoPresenters exactly: no password, no session, nothing to sign in with
// until they ask for a link at the address given — the same door every
// speaker already walks through.

import { checkedBatch, guard, newId, now, ChangesMismatchError, StaleStateError } from '../lib/db';
import { findPersonByEmail } from './account';

/**
 *   'done'     — it landed
 *   'no-name'  — no name was given; nothing was written
 *   'no-email' — no address was given; nothing was written
 *   'self'     — that address is the speaker's own; nothing was written
 *   'moved'    — the precondition had already changed under them
 *   'trouble'  — something unexpected; nothing was written
 */
export type HelperOutcome = 'done' | 'no-name' | 'no-email' | 'self' | 'moved' | 'trouble';

// Never rendered. checkedBatch wants a message for the StaleStateError it
// throws; the screen's own words live in routes/public/portal.ts.
const STALE = 'precondition moved';

function outcomeOf(e: unknown, where: string): HelperOutcome {
  if (e instanceof StaleStateError) return 'moved';
  if (e instanceof ChangesMismatchError) return 'moved';
  console.error(`${where}: ${String(e)}`);
  return 'trouble';
}

const NAME_MAX = 120;
const norm = (email: string): string => email.trim().toLowerCase();

// A speaker may only add a helper against a talk they actually have at this
// event — the same "own row" scoping withdrawProposal's WITHDRAWABLE keeps,
// read again here rather than trusted from the fact the caller reached this
// route at all.
const SPEAKS_HERE = `
  SELECT 1 FROM participation pa
    JOIN submission s ON s.id = pa.submission_id
   WHERE pa.person_id = ?1 AND s.event_id = ?2`;

/**
 * Add (or, for an address that helped before and was later removed,
 * reactivate) one helper on this speaker's own list. Idempotent against an
 * already-active helper: adding someone twice lands as 'done' either way,
 * because the end state — this person is an active helper — is already true.
 */
export async function addHelper(
  db: D1Database,
  eventId: string,
  speakerPersonId: string,
  input: { name: string; email: string },
  nowMs: number = now()
): Promise<HelperOutcome> {
  const name = input.name.trim().slice(0, NAME_MAX);
  if (!name) return 'no-name';
  const email = norm(input.email);
  if (!email.includes('@')) return 'no-email';

  const existing = await findPersonByEmail(db, email);
  if (existing && existing.id === speakerPersonId) return 'self';

  const helperPersonId = existing?.id ?? newId('per');
  const helperRowId = newId('hlp');

  const statements: D1PreparedStatement[] = [
    guard(db, `SELECT 1 WHERE NOT EXISTS (${SPEAKS_HERE})`, speakerPersonId, eventId),
  ];
  const expect: (number | 'any')[] = [0];

  if (!existing) {
    statements.push(
      db
        .prepare(
          `INSERT INTO person (id, email, name, sort_name, share_contact, created_at)
           VALUES (?,?,?,?,'{}',?)`
        )
        .bind(helperPersonId, email, name, name, nowMs)
    );
    expect.push(1);
  }

  statements.push(
    db
      .prepare(
        `UPDATE speaker_helper SET added_at = ?, removed_at = NULL
          WHERE event_id = ? AND speaker_person_id = ? AND helper_person_id = ? AND removed_at IS NOT NULL`
      )
      .bind(nowMs, eventId, speakerPersonId, helperPersonId)
  );
  expect.push('any');

  statements.push(
    db
      .prepare(
        `INSERT INTO speaker_helper (id, event_id, speaker_person_id, helper_person_id, added_at)
         SELECT ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM speaker_helper
                              WHERE event_id = ? AND speaker_person_id = ? AND helper_person_id = ?)`
      )
      .bind(helperRowId, eventId, speakerPersonId, helperPersonId, nowMs, eventId, speakerPersonId, helperPersonId)
  );
  expect.push('any');

  try {
    await checkedBatch(db, statements, expect, STALE);
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'addHelper');
  }
}

/**
 * Let one of this speaker's own helpers go. Only a row naming this speaker as
 * the one being helped can ever be touched — a fabricated row id from
 * another speaker's list, or another event's, updates nothing.
 */
export async function removeHelper(
  db: D1Database,
  eventId: string,
  speakerPersonId: string,
  helperRowId: string,
  nowMs: number = now()
): Promise<HelperOutcome> {
  if (!helperRowId) return 'moved';
  try {
    await checkedBatch(
      db,
      [
        db
          .prepare(
            `UPDATE speaker_helper SET removed_at = ?
              WHERE id = ? AND event_id = ? AND speaker_person_id = ? AND removed_at IS NULL`
          )
          .bind(nowMs, helperRowId, eventId, speakerPersonId),
      ],
      [{ atLeast: 1 }],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'removeHelper');
  }
}
