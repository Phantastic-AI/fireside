// Asking, and writing to people. The two acts an organizer takes toward a
// person rather than toward a proposal.
//
// An ask is one click, because it is small, private until they look, and
// undoable: it lands on their portal, it can be withdrawn from the same screen
// it was made on, and nothing leaves the building. Writing to people is the
// other kind of act entirely — it goes to everybody at once — so it takes the
// outbox's two passes, arithmetic and all (D-024). It takes them on its OWN
// number: releaseDecisions counts a decision cohort and would not know what to
// do with a note, and the notes band never borrows the decisions band's count.
// Two acts, two guards, two confirms, and neither can send the other's post.
//
// Every write here is a guarded batch (lib/db.ts). The guards are the things
// the screen read a moment earlier, re-read at write time: the person really is
// at this event, the proposal really is theirs, the task really is still open,
// the audience really is somebody, and the count really is the count.

import { checkedBatch, guard, newId, now, StaleStateError } from '../lib/db';
import { label } from '../lib/labels';
import { EDIT_ROLES, LETTER_ROLES, requireScope } from '../queries/admin';
import { isRealAddress, type Principal } from './account';

/* ------------------------------------------------------------------ *
 * What an ask can be
 * ------------------------------------------------------------------ */

/**
 * The three shapes an ask comes in. 02 §6 has no row for a task's kind — it
 * labels the task's STATE (to do, done, not needed) and leaves the kind to the
 * organizer — so the words live here, next to the values they name, in the
 * same way proposal.ts keeps its own words for a cancellation's reason.
 * `value` is what is stored; `word` is the only thing ever rendered.
 */
export const TASK_KINDS: readonly { value: string; word: string }[] = [
  { value: 'file_request', word: 'Something to send in' },
  { value: 'confirmation', word: 'Something to confirm' },
  { value: 'information', word: 'Something to tell you' },
];

const TITLE_MAX = 140;
const SUBJECT_MAX = 120;
const BODY_MAX = 2000;

/** Why an ask did not go on the list. One closed set; the screens own the
 *  sentences, because the sentence depends on which screen you are standing on. */
export type AskRefusal = 'not-here' | 'no-title' | 'no-kind' | 'bad-date' | 'trouble';

export type AskResult = { ok: true; taskId: string } | { ok: false; code: AskRefusal };

/** A calendar day, and a real one: '2026-02-31' is a date nobody has. */
function isCalendarDay(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/**
 * Put one thing on one person's list.
 *
 * The due date is a calendar day and stays one: `task.due_on` is the day
 * itself, with no clock and no zone on it, and every reader in the product
 * compares it against today on the event's own clock — which is what "due at
 * the end of that day" means in practice, wherever the person reading it
 * happens to be standing.
 */
export async function createTask(
  db: D1Database,
  principal: Principal,
  eventId: string,
  input: {
    personId: string;
    submissionId?: string | null;
    kind: string;
    title: string;
    dueOn?: string | null;
  }
): Promise<AskResult> {
  requireScope(principal, eventId, EDIT_ROLES);

  const title = input.title.trim();
  if (title === '' || title.length > TITLE_MAX) return { ok: false, code: 'no-title' };
  if (!TASK_KINDS.some((k) => k.value === input.kind)) return { ok: false, code: 'no-kind' };

  const dueRaw = (input.dueOn ?? '').trim();
  if (dueRaw !== '' && !isCalendarDay(dueRaw)) return { ok: false, code: 'bad-date' };
  const dueOn = dueRaw === '' ? null : dueRaw;

  const submissionId = (input.submissionId ?? '').trim() || null;
  const taskId = newId('tsk');

  // Somebody is at this event because a proposal of theirs is (01 inv.: a draft
  // has not been sent, so it does not put anyone on the roster). Asked again
  // here, inside the batch, because the person page may have been open a while.
  const statements = [
    guard(
      db,
      `SELECT 1 WHERE NOT EXISTS (
         SELECT 1 FROM participation pa JOIN submission s ON s.id = pa.submission_id
         WHERE pa.person_id = ?1 AND s.event_id = ?2 AND s.state <> 'draft')`,
      input.personId,
      eventId
    ),
  ];
  const expect: (number | 'any')[] = [0];

  if (submissionId !== null) {
    // An ask about a proposal is an ask about THEIR proposal. The schema's
    // trigger would stop one that crosses events; this stops one that crosses
    // people, and it refuses as a sentence rather than as an abort.
    statements.push(
      guard(
        db,
        `SELECT 1 WHERE NOT EXISTS (
           SELECT 1 FROM participation pa JOIN submission s ON s.id = pa.submission_id
           WHERE pa.person_id = ?1 AND s.id = ?2 AND s.event_id = ?3 AND s.state <> 'draft')`,
        input.personId,
        submissionId,
        eventId
      )
    );
    expect.push(0);
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO task (id, event_id, person_id, submission_id, kind, title, due_on)
         VALUES (?,?,?,?,?,?,?)`
      )
      .bind(taskId, eventId, input.personId, submissionId, input.kind, title, dueOn)
  );
  expect.push(1);

  try {
    await checkedBatch(db, statements, expect, 'that person is not on this conference');
  } catch (e) {
    if (e instanceof StaleStateError) return { ok: false, code: 'not-here' };
    if (e instanceof Error && e.name === 'ChangesMismatchError') return { ok: false, code: 'trouble' };
    throw e;
  }
  return { ok: true, taskId };
}

export type CancelResult = { ok: true } | { ok: false; code: 'gone' | 'trouble' };

/**
 * Take an ask back. Only an open one can be withdrawn — a task somebody has
 * already done is a thing that happened, and the reason a cancellation carries
 * is 'manual', which is the schema's word for "an organizer decided so".
 */
export async function cancelTask(
  db: D1Database,
  principal: Principal,
  eventId: string,
  taskId: string
): Promise<CancelResult> {
  requireScope(principal, eventId, EDIT_ROLES);
  const t = now();

  const OPEN = `SELECT 1 FROM task
    WHERE id = ?1 AND event_id = ?2 AND completed_at IS NULL AND cancelled_at IS NULL`;

  try {
    await checkedBatch(
      db,
      [
        guard(db, `SELECT 1 WHERE NOT EXISTS (${OPEN})`, taskId, eventId),
        db
          .prepare(
            `UPDATE task SET cancelled_at = ?3, cancel_reason = 'manual'
             WHERE id = ?1 AND event_id = ?2 AND completed_at IS NULL AND cancelled_at IS NULL`
          )
          .bind(taskId, eventId, t),
      ],
      [0, 1],
      'that one is already off their list'
    );
  } catch (e) {
    if (e instanceof StaleStateError) return { ok: false, code: 'gone' };
    if (e instanceof Error && e.name === 'ChangesMismatchError') return { ok: false, code: 'gone' };
    throw e;
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Writing to people
 * ------------------------------------------------------------------ */

const lower = (s: string): string => s.toLowerCase();

/**
 * Who a message goes to. Four rooms an organizer can actually address, and
 * every one of them says its state in the label map's word, so a ruling that
 * moves a word moves this select with it. The SQL is a set of people, never a
 * set of proposals: two accepted talks by one speaker is one letter.
 */
export type AudienceKey = 'accepted' | 'maybe' | 'undecided' | 'owing';

const speakersInState = (state: string): string =>
  `SELECT DISTINCT pa.person_id FROM participation pa
     JOIN submission s ON s.id = pa.submission_id
    WHERE s.event_id = ?1 AND s.state = '${state}'`;

export const AUDIENCES: readonly { key: AudienceKey; word: string; sql: string }[] = [
  {
    key: 'accepted',
    word: `Everyone ${lower(label('submission.accepted', 'backstage'))}`,
    sql: speakersInState('accepted'),
  },
  {
    key: 'maybe',
    word: `Everyone marked a ${lower(label('submission.waitlisted', 'backstage'))}`,
    sql: speakersInState('waitlisted'),
  },
  {
    key: 'undecided',
    word: `Everyone still ${lower(label('submission.submitted', 'backstage'))}`,
    sql: speakersInState('submitted'),
  },
  {
    key: 'owing',
    word: `Everyone with something ${lower(label('task.open', 'backstage'))}`,
    sql: `SELECT DISTINCT t.person_id FROM task t
            WHERE t.event_id = ?1 AND t.completed_at IS NULL AND t.cancelled_at IS NULL`,
  },
];

export type WriteRefusal = 'no-audience' | 'no-subject' | 'no-body' | 'nobody' | 'trouble';

export type WriteResult = { ok: true; staged: number; at: number } | { ok: false; code: WriteRefusal };

/**
 * Write one message to a whole room, in one set-based statement: the audience
 * is a SELECT, and the letters are its rows. Nothing is delivered — these sit
 * in the outbox with the decisions until somebody sends them, which is the
 * whole point of having an outbox at all.
 *
 * The instant they were written on is the group's name afterwards: it is what
 * the screen shows them under, and what taking them back asks for.
 */
export async function stageNotes(
  db: D1Database,
  principal: Principal,
  eventId: string,
  input: { audience: string; subject: string; body: string }
): Promise<WriteResult> {
  requireScope(principal, eventId, LETTER_ROLES);

  const audience = AUDIENCES.find((a) => a.key === input.audience);
  if (!audience) return { ok: false, code: 'no-audience' };
  const subject = input.subject.trim();
  if (subject === '' || subject.length > SUBJECT_MAX) return { ok: false, code: 'no-subject' };
  const body = input.body.trim();
  if (body === '' || body.length > BODY_MAX) return { ok: false, code: 'no-body' };

  const t = now();
  let staged = 0;
  try {
    const results = await checkedBatch(
      db,
      [
        // Writing to nobody is not a small version of writing to somebody.
        guard(db, `SELECT 1 WHERE NOT EXISTS (${audience.sql})`, eventId),
        db
          .prepare(
            `INSERT INTO message (id, event_id, person_id, kind, subject, body, created_at)
             SELECT 'msg-' || lower(hex(randomblob(9))), ?1, who.person_id, 'note', ?2, ?3, ?4
             FROM (${audience.sql}) who`
          )
          .bind(eventId, subject, body, t),
      ],
      [0, { atLeast: 1 }],
      'there is nobody in that room yet'
    );
    staged = results[1]?.meta.changes ?? 0;
  } catch (e) {
    if (e instanceof StaleStateError) return { ok: false, code: 'nobody' };
    if (e instanceof Error && e.name === 'ChangesMismatchError') return { ok: false, code: 'nobody' };
    throw e;
  }
  return { ok: true, staged, at: t };
}

export type TakeBackResult = { ok: true; taken: number } | { ok: false; code: 'gone' | 'trouble' };

/**
 * Unwrite a group that has not gone. This is what makes the writing itself one
 * click (D-024): the act is undoable right up to the moment it is sent, and
 * after that it is not, which is what the second pass is for.
 */
export async function withdrawNotes(
  db: D1Database,
  principal: Principal,
  eventId: string,
  writtenAt: number
): Promise<TakeBackResult> {
  requireScope(principal, eventId, LETTER_ROLES);

  const GROUP = `SELECT 1 FROM message
    WHERE event_id = ?1 AND kind = 'note' AND delivered_at IS NULL AND created_at = ?2`;

  let taken = 0;
  try {
    const results = await checkedBatch(
      db,
      [
        guard(db, `SELECT 1 WHERE NOT EXISTS (${GROUP})`, eventId, writtenAt),
        db
          .prepare(
            `DELETE FROM message
             WHERE event_id = ?1 AND kind = 'note' AND delivered_at IS NULL AND created_at = ?2`
          )
          .bind(eventId, writtenAt),
      ],
      [0, { atLeast: 1 }],
      'those have already gone'
    );
    taken = results[1]?.meta.changes ?? 0;
  } catch (e) {
    if (e instanceof StaleStateError) return { ok: false, code: 'gone' };
    if (e instanceof Error && e.name === 'ChangesMismatchError') return { ok: false, code: 'gone' };
    throw e;
  }
  return { ok: true, taken };
}

/** The shape release.ts sends through, deliberately identical — one binding,
 *  one from-address, and no knowledge of either in this file. */
type EmailBinding = {
  send(msg: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
  }): Promise<unknown>;
};

export type SendNotesResult =
  | { ok: true; released: number; emailed: number }
  | { ok: false; code: 'moved' };

/**
 * Send every staged message that is not a decision.
 *
 * The same two-pass arithmetic as releaseDecisions and none of its cohort:
 * a note is not about a proposal, has no decision to go stale against, and
 * carries no version — so what is guarded is only the count the human read.
 * If a note was written or taken back since they read it, nothing goes and the
 * screen asks them to look again.
 */
export async function releaseNotes(
  db: D1Database,
  principal: Principal,
  eventId: string,
  expectedCount: number,
  email: { binding: EmailBinding; from: string } | null,
  waitUntil: (p: Promise<unknown>) => void
): Promise<SendNotesResult> {
  requireScope(principal, eventId, LETTER_ROLES);
  if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) return { ok: false, code: 'moved' };

  const t = now();
  const COHORT = `SELECT m.id AS message_id FROM message m
    WHERE m.event_id = ?1 AND m.kind = 'note' AND m.delivered_at IS NULL`;

  try {
    await checkedBatch(
      db,
      [
        guard(db, `SELECT 1 WHERE (SELECT COUNT(*) FROM (${COHORT})) <> ?2`, eventId, expectedCount),
        db
          .prepare(`UPDATE message SET delivered_at = ?2 WHERE id IN (SELECT message_id FROM (${COHORT}))`)
          .bind(eventId, t),
      ],
      [0, expectedCount],
      'the outbox moved while you were reading'
    );
  } catch (e) {
    if (e instanceof Error && (e.name === 'StaleStateError' || e.name === 'ChangesMismatchError')) {
      return { ok: false, code: 'moved' };
    }
    throw e;
  }

  // After the commit, exactly as release.ts does it: real addresses get real
  // email, the synthetic cast never leaves the building, and a send that fails
  // costs nothing — the portal is the log of record and emailed_at records only
  // what actually left.
  let emailed = 0;
  if (email) {
    const recipients = await db
      .prepare(
        `SELECT m.id, m.subject, m.body, p.email, p.name FROM message m
         JOIN person p ON p.id = m.person_id
         WHERE m.event_id = ?1 AND m.kind = 'note' AND m.delivered_at = ?2 AND p.email IS NOT NULL`
      )
      .bind(eventId, t)
      .all<{ id: string; subject: string; body: string; email: string; name: string }>();
    const real = recipients.results.filter((r) => isRealAddress(r.email));
    emailed = real.length;
    waitUntil(
      (async () => {
        for (const r of real) {
          try {
            await email.binding.send({
              to: r.email,
              from: { email: email.from, name: 'Fireside' },
              subject: r.subject,
              text: `Hello ${r.name},\n\n${r.body}\n\n— sent from Fireside.`,
            });
            await db.prepare('UPDATE message SET emailed_at = ? WHERE id = ?').bind(now(), r.id).run();
          } catch {
            // it is in their portal either way; email is the copy, not the letter
          }
        }
      })()
    );
  }

  return { ok: true, released: expectedCount, emailed };
}
