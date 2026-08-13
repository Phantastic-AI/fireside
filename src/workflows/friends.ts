// Δ conn — the exchange's three writes: ask, accept, let go.
//
// Standing: an attendee has standing over exactly the friend_request rows
// that name them — as requester or as recipient — and nothing else. Every
// statement below carries event_id and the caller's own person_id in its own
// WHERE clause, the same discipline workflows/social.ts already proved.
//
// The double opt-in, RELIABLY: sending a request when the other side has
// already asked never produces two rows racing each other — the send is
// guarded against any live row already existing between the pair, in either
// direction, so a second "send" while one is pending simply lands as 'moved'
// and the caller re-renders, which is exactly where the recipient's own
// Accept button already lives. Acceptance only ever touches a row addressed
// to the caller. Ending a friendship (revoke, decline, or cancel — one verb,
// D-024's "one click, undoable") only ever touches a row naming the caller on
// either side, pending or accepted alike.

import { checkedBatch, guard, newId, now, ChangesMismatchError, StaleStateError } from '../lib/db';

export type FriendOutcome = 'done' | 'moved' | 'trouble';

const STALE = 'that moved while you were looking';

function outcomeOf(e: unknown, where: string): FriendOutcome {
  if (e instanceof StaleStateError) return 'moved';
  if (e instanceof ChangesMismatchError) return 'moved';
  console.error(`${where}: ${String(e)}`);
  return 'trouble';
}

/**
 * Ask to connect. One row, one direction. Refuses to write a second row when
 * a live one already exists between this pair for this event, whichever
 * direction it faces — asking someone who already asked you is not a new
 * request, it is the Accept button they are already looking at.
 *
 * A row that was revoked earlier is reactivated in place (UPDATE) rather than
 * inserted again, because (event_id, requester_id, recipient_id) is UNIQUE:
 * the history of one pair asking each other, again, after letting go, is one
 * row's whole life, not a new one each time.
 */
export async function sendFriendRequest(
  db: D1Database,
  eventId: string,
  meId: string,
  recipientId: string,
  nowMs: number = now()
): Promise<FriendOutcome> {
  if (!recipientId || recipientId === meId) return 'moved';
  try {
    await checkedBatch(
      db,
      [
        guard(
          db,
          `SELECT 1 FROM friend_request
             WHERE event_id = ? AND revoked_at IS NULL
               AND ((requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?))`,
          eventId,
          meId,
          recipientId,
          recipientId,
          meId
        ),
        db
          .prepare(
            `UPDATE friend_request SET requested_at = ?, accepted_at = NULL, revoked_at = NULL
              WHERE event_id = ? AND requester_id = ? AND recipient_id = ? AND revoked_at IS NOT NULL`
          )
          .bind(nowMs, eventId, meId, recipientId),
        db
          .prepare(
            `INSERT INTO friend_request (id, event_id, requester_id, recipient_id, requested_at)
             SELECT ?, ?, ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM friend_request WHERE event_id = ? AND requester_id = ? AND recipient_id = ?)
                AND EXISTS (SELECT 1 FROM person WHERE id = ?)`
          )
          .bind(newId('frq'), eventId, meId, recipientId, nowMs, eventId, meId, recipientId, recipientId),
      ],
      [0, 'any', 'any'],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'sendFriendRequest');
  }
}

/**
 * Accept a request addressed to me. Only a row where I am the recipient can
 * ever be touched — a fabricated requester id in the form updates nothing,
 * which is the same "wrong id costs nothing" shape setStar already uses.
 */
export async function acceptFriendRequest(
  db: D1Database,
  eventId: string,
  meId: string,
  requesterId: string,
  nowMs: number = now()
): Promise<FriendOutcome> {
  if (!requesterId) return 'moved';
  try {
    await checkedBatch(
      db,
      [
        db
          .prepare(
            `UPDATE friend_request SET accepted_at = ?
              WHERE event_id = ? AND requester_id = ? AND recipient_id = ?
                AND accepted_at IS NULL AND revoked_at IS NULL`
          )
          .bind(nowMs, eventId, requesterId, meId),
      ],
      ['any'],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'acceptFriendRequest');
  }
}

/**
 * Let go — cancelling a request I sent, declining one I was sent, or ending
 * a friendship already accepted: the same one click either side owns at any
 * point in the relationship's life. Both directions in one statement, since
 * the caller only ever knows "the other person's id", not which of them
 * asked first.
 */
export async function endFriendship(
  db: D1Database,
  eventId: string,
  meId: string,
  otherId: string,
  nowMs: number = now()
): Promise<FriendOutcome> {
  if (!otherId) return 'moved';
  try {
    await checkedBatch(
      db,
      [
        db
          .prepare(
            `UPDATE friend_request SET revoked_at = ?
              WHERE event_id = ? AND revoked_at IS NULL
                AND ((requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?))`
          )
          .bind(nowMs, eventId, meId, otherId, otherId, meId),
      ],
      ['any'],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'endFriendship');
  }
}
