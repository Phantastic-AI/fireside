// Bidirectional email, the inbound half: a speaker (or their helper) replies to
// a reminder with the deck attached, and it lands on the deliverable — no app,
// no sign-in. The outbound reminder carries Reply-To: reply+<id>@<domain>; this
// is what happens when that reply comes back.
//
// The id (schema/0014) names the file-request task and its speaker. It carries
// no authority on its own: the handler trusts only the SMTP envelope-from
// (message.from, which the skill notes is trustworthy where header addresses
// are not), and accepts the reply only if that address is the speaker's own or
// one of their active helpers'. A ticket forwarded to a stranger submits
// nothing. Reuses saveDeck, so the versioning, type/size limits, and task-done
// bookkeeping are exactly the app upload's — one code path, one set of rules.

import PostalMime from 'postal-mime';
import { newId, now } from '../lib/db';
import { saveDeck, DECK_MAX_BYTES } from './files';

// replyLocalPart lives in ./files (where the reminders are built) so the
// dependency runs one way: files → nothing here, reply-email → files. Avoids a
// cycle, since this module reuses saveDeck.

const norm = (email: string): string => email.trim().toLowerCase();

/** The ticket id out of a `reply+<id>@host` recipient, or null. Tolerant of the
 *  address arriving as `<reply+id@host>` or with a display name. */
export function ticketIdFromRecipient(to: string): string | null {
  const at = to.lastIndexOf('@');
  const local = (at > 0 ? to.slice(0, at) : to).replace(/^.*</, '').trim();
  const m = /^reply\+([a-z0-9-]{6,64})$/i.exec(local);
  return m?.[1] ?? null;
}

export type ReplyOutcome =
  | 'stored' // the deck landed on the deliverable
  | 'no-ticket' // recipient was not a reply+<id> we know
  | 'not-allowed' // the sender is neither the speaker nor an active helper
  | 'no-file' // the reply carried no deck-shaped attachment
  | 'moved' // the task had already closed or changed
  | 'trouble';

/** The whole inbound act, from a parsed recipient + sender + raw MIME. Returns a
 *  word; the email() handler decides whether to acknowledge or drop. */
export async function handleDeckReply(
  db: D1Database,
  bucket: R2Bucket,
  opts: { to: string; from: string; raw: ArrayBuffer }
): Promise<ReplyOutcome> {
  const ticketId = ticketIdFromRecipient(opts.to);
  if (!ticketId) return 'no-ticket';

  const ticket = await db
    .prepare('SELECT task_id, speaker_person_id FROM reply_ticket WHERE id = ?')
    .bind(ticketId)
    .first<{ task_id: string; speaker_person_id: string }>();
  if (!ticket) return 'no-ticket';

  // Authorisation is the envelope-from, never the ticket alone: the speaker
  // whose task it is, or a helper actively helping them at this task's event.
  const from = norm(opts.from);
  const allowed = await senderIsAllowed(db, ticket.task_id, ticket.speaker_person_id, from);
  if (!allowed) return 'not-allowed';

  let parsed;
  try {
    parsed = await PostalMime.parse(opts.raw);
  } catch {
    return 'trouble';
  }

  // The first attachment that looks like a deck, within the size the app
  // itself takes. saveDeck re-checks the type from the extension, so a wrong
  // kind is refused there too.
  const att = (parsed.attachments ?? []).find((a) => {
    const name = a.filename ?? '';
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    return ['pdf', 'pptx', 'key', 'zip'].includes(ext);
  });
  if (!att || !att.content) return 'no-file';

  const bytes = att.content instanceof ArrayBuffer ? att.content : new TextEncoder().encode(String(att.content));
  if (bytes.byteLength > DECK_MAX_BYTES) return 'moved'; // too big; the app path says so, here we just decline
  const file = new File([bytes], att.filename ?? 'slides.pdf');

  const outcome = await saveDeck(db, bucket, ticket.speaker_person_id, ticket.task_id, file);
  if (outcome !== 'done') return outcome === 'moved' ? 'moved' : 'trouble';

  // A note on the record so the organizer sees the deck came in by email, and
  // any words in the reply are kept rather than lost.
  await noteTheReply(db, ticket.task_id, ticket.speaker_person_id, from, parsed.text ?? '');
  return 'stored';
}

/** The reply's sender is the speaker themselves, or an active helper of the
 *  speaker at this task's event. */
async function senderIsAllowed(
  db: D1Database,
  taskId: string,
  speakerPersonId: string,
  from: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1
         FROM task t
         JOIN person sp ON sp.id = ?2
        WHERE t.id = ?1
          AND (
            lower(sp.email) = ?3
            OR EXISTS (
              SELECT 1 FROM speaker_helper sh
                JOIN person hp ON hp.id = sh.helper_person_id
               WHERE sh.event_id = t.event_id AND sh.speaker_person_id = ?2
                 AND sh.removed_at IS NULL AND lower(hp.email) = ?3
            )
          )`
    )
    .bind(taskId, speakerPersonId, from)
    .first();
  return row !== null;
}

async function noteTheReply(
  db: D1Database,
  taskId: string,
  speakerPersonId: string,
  from: string,
  text: string
): Promise<void> {
  const taskRow = await db
    .prepare('SELECT event_id, submission_id FROM task WHERE id = ?')
    .bind(taskId)
    .first<{ event_id: string; submission_id: string | null }>();
  if (!taskRow) return;
  const trimmed = text.trim().slice(0, 2000);
  const body = trimmed
    ? `Sent the deck by email (from ${from}):\n\n${trimmed}`
    : `Sent the deck by email (from ${from}).`;
  await db
    .prepare(
      `INSERT INTO message (id, event_id, person_id, submission_id, kind, subject, body, created_at, delivered_at)
       VALUES (?1, ?2, ?3, ?4, 'note', 'Deck received by email', ?5, ?6, ?6)`
    )
    .bind(newId('msg'), taskRow.event_id, speakerPersonId, taskRow.submission_id, body, now())
    .run();
}
