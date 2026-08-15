// The two writes a follower owns about a speaker they follow: following one,
// and letting the follow go. Both are the follower's own private act, scoped
// to them in the SQL — never trusted from the caller — the same discipline
// workflows/friends.ts and workflows/helpers.ts keep.
//
// A follow only lands on a real speaker: the guard reads that the target
// actually has a non-draft talk at the event the follow was made from, so a
// stray person id off the address bar cannot be followed as if they were on
// the program.

import { checkedBatch, guard, newId, now, ChangesMismatchError, StaleStateError } from '../lib/db';

/**
 *   'done'        — it landed (followed, or already following)
 *   'self'        — that speaker is the follower's own self; nothing written
 *   'not-speaker' — the target has no talk at this event; nothing written
 *   'moved'       — the precondition changed under them
 *   'trouble'     — something unexpected; nothing written
 */
export type FollowOutcome = 'done' | 'self' | 'not-speaker' | 'moved' | 'trouble';

const STALE = 'precondition moved';

function outcomeOf(e: unknown, where: string): FollowOutcome {
  if (e instanceof StaleStateError) return 'not-speaker';
  if (e instanceof ChangesMismatchError) return 'moved';
  console.error(`${where}: ${String(e)}`);
  return 'trouble';
}

// The target must actually be on the program at the event the follow is made
// from — the same "read it, do not trust it" scoping every other write keeps.
const SPEAKS_HERE = `
  SELECT 1 FROM participation pa
    JOIN submission s ON s.id = pa.submission_id
   WHERE pa.person_id = ?1 AND s.event_id = ?2 AND s.state <> 'draft'`;

/**
 * Follow one speaker. Idempotent: following someone already followed lands as
 * 'done' either way, because the end state (this person follows that speaker)
 * is already true. Insert-or-reactivate, exactly addHelper's shape.
 */
export async function followSpeaker(
  db: D1Database,
  followerPersonId: string,
  speakerPersonId: string,
  eventId: string,
  nowMs: number = now()
): Promise<FollowOutcome> {
  if (followerPersonId === speakerPersonId) return 'self';
  const rowId = newId('flw');
  try {
    await checkedBatch(
      db,
      [
        // Guard: the target speaks here. `SELECT 1 WHERE NOT EXISTS(...)`
        // returns a row precisely when they do NOT, so expecting 0 rows makes
        // "not a speaker here" abort the whole write.
        guard(db, `SELECT 1 WHERE NOT EXISTS (${SPEAKS_HERE})`, speakerPersonId, eventId),
        db
          .prepare(
            `UPDATE speaker_follow SET created_at = ?, unfollowed_at = NULL
              WHERE follower_person_id = ? AND speaker_person_id = ? AND unfollowed_at IS NOT NULL`
          )
          .bind(nowMs, followerPersonId, speakerPersonId),
        db
          .prepare(
            `INSERT INTO speaker_follow (id, follower_person_id, speaker_person_id, origin_event_id, created_at)
             SELECT ?, ?, ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM speaker_follow
                                  WHERE follower_person_id = ? AND speaker_person_id = ?)`
          )
          .bind(rowId, followerPersonId, speakerPersonId, eventId, nowMs, followerPersonId, speakerPersonId),
      ],
      [0, 'any', 'any'],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'followSpeaker');
  }
}

/** Stop following. Only the follower's own live row can ever be touched. */
export async function unfollowSpeaker(
  db: D1Database,
  followerPersonId: string,
  speakerPersonId: string,
  nowMs: number = now()
): Promise<FollowOutcome> {
  try {
    await checkedBatch(
      db,
      [
        db
          .prepare(
            `UPDATE speaker_follow SET unfollowed_at = ?
              WHERE follower_person_id = ? AND speaker_person_id = ? AND unfollowed_at IS NULL`
          )
          .bind(nowMs, followerPersonId, speakerPersonId),
      ],
      ['any'],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'unfollowSpeaker');
  }
}
