// CNT-05 — the write half of a deliverable's comment thread. A short back
// and forth about one file request, visible to the speaker who owes it and
// the organizers who asked for it — nothing fancier than that, and no email
// travels because of it (SessionBoard itself sends none for a comment).
//
// Threaded on the task rather than on one file version (workflows/files.ts's
// own doc comment explains the versioning choice this mirrors): a reply
// written about the first upload still has to read true once a second one
// lands, and keeping the thread off `file` is what makes that automatic.
//
// Two doors, one table. A speaker may only write on their own request; an
// organizer may only write on a request that belongs to their conference.
// Both guards are re-read at write time, the same discipline as every other
// guarded batch in this build.

import { checkedBatch, guard, newId, now, StaleStateError, ChangesMismatchError } from '../lib/db';
import { EDIT_ROLES, requireScope } from '../queries/admin';
import type { Principal } from './account';

export const COMMENT_MAX = 1000;

/**
 *   'done'    — it is on the thread
 *   'empty'   — nothing was written; nothing was saved
 *   'moved'   — that request is not theirs to comment on, or is not a file
 *               request at all
 *   'trouble' — something unexpected; nothing was written
 */
export type CommentOutcome = 'done' | 'empty' | 'moved' | 'trouble';

function outcomeOf(e: unknown, where: string): CommentOutcome {
  if (e instanceof StaleStateError) return 'moved';
  if (e instanceof ChangesMismatchError) return 'moved';
  console.error(`${where}: ${String(e)}`);
  return 'trouble';
}

const STILL_THEIRS = `SELECT 1 FROM task
   WHERE id = ?1 AND person_id = ?2 AND kind = 'file_request'`;

/** The speaker's own reply — only on a request that is theirs. */
export async function postCommentAsSpeaker(
  db: D1Database,
  personId: string,
  taskId: string,
  body: string
): Promise<CommentOutcome> {
  const text = body.trim().slice(0, COMMENT_MAX);
  if (text === '') return 'empty';
  const id = newId('fcm');
  try {
    await checkedBatch(
      db,
      [
        guard(db, `SELECT 1 WHERE NOT EXISTS (${STILL_THEIRS})`, taskId, personId),
        db
          .prepare('INSERT INTO file_comment (id, task_id, author_person_id, body, created_at) VALUES (?,?,?,?,?)')
          .bind(id, taskId, personId, text, now()),
      ],
      [0, 1],
      'that request is not on your list'
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'postCommentAsSpeaker');
  }
}

const ON_THIS_EVENT = `SELECT 1 FROM task
   WHERE id = ?1 AND event_id = ?2 AND kind = 'file_request'`;

/** An organizer's reply — only on a request that belongs to their conference. */
export async function postCommentAsOrganizer(
  db: D1Database,
  principal: Principal,
  eventId: string,
  taskId: string,
  body: string
): Promise<CommentOutcome> {
  requireScope(principal, eventId, EDIT_ROLES);
  const text = body.trim().slice(0, COMMENT_MAX);
  if (text === '') return 'empty';
  const id = newId('fcm');
  try {
    await checkedBatch(
      db,
      [
        guard(db, `SELECT 1 WHERE NOT EXISTS (${ON_THIS_EVENT})`, taskId, eventId),
        db
          .prepare('INSERT INTO file_comment (id, task_id, author_person_id, body, created_at) VALUES (?,?,?,?,?)')
          .bind(id, taskId, principal.personId, text, now()),
      ],
      [0, 1],
      'that request is not on this conference'
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'postCommentAsOrganizer');
  }
}
