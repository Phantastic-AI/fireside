// SPK-08 and CNT-02 — the two things a speaker actually hands over (a
// photograph of themselves, the deck they will stand behind), and the one act
// an organizer performs about them, which is asking again.
//
// ONE KEY PER THING, WITH ONE EXCEPTION. A photograph lives at
// 'headshots/{personId}' — a stable address, so a second send replaces the
// first instead of piling up beside it, and nowhere in this product is there
// a screen for a speaker's earlier photographs. A deck is the deliberate
// exception (CNT-04): it lives at 'slides/{taskId}/{fileId}', one key per
// upload, because the organizer's whole complaint about the old single-key
// design was that "replaced" meant "gone" — a version list has to have
// something to list. `replaced_at IS NULL` marks the one current row in a
// deck's family; every write that seats a new one retires the old one in the
// same batch, so a reader never catches two rows both claiming to be current.
// The corrected deck at 21:40 the night before is still the common case, not
// the exception — it just now keeps the draft it replaced.
//
// BYTES FIRST, ROW AFTER. R2 and D1 share no transaction, so the object goes
// up and then the row that names it goes in. If the row fails, the object
// just written is taken away again on the way out — a fresh key means there
// is never a survivor's bytes to protect from that cleanup.
//
// THE KIND IS OURS, NOT THE BROWSER'S. content_type is derived from the
// short list this file accepts and never from what the request claims. A page
// that serves a stranger's content type back on its own origin has handed the
// origin over.
//
// Every D1 write is a guarded checkedBatch (lib/db.ts). Every outcome is one
// word from a closed set: the *screen* owns the sentence, exactly as in
// workflows/portal-actions.ts.

import { checkedBatch, guard, newId, now, ChangesMismatchError, StaleStateError } from '../lib/db';
import { isRealAddress } from './account';
import { helperContactsFor } from '../queries/helpers';

/* ------------------------------------------------------------------ *
 * What happened, in six words the screens know how to say
 * ------------------------------------------------------------------ */

/**
 *   'done'       — it landed
 *   'nothing'    — no bytes came through; nothing was written
 *   'too-big'    — over the size this door takes
 *   'wrong-kind' — not one of the kinds this door takes
 *   'moved'      — the thing had already changed under them
 *   'trouble'    — something unexpected; nothing was written
 */
export type FileOutcome = 'done' | 'nothing' | 'too-big' | 'wrong-kind' | 'moved' | 'trouble';

// Never rendered. checkedBatch wants a message for the StaleStateError it
// throws; the screens' own words live in their own files.
const STALE = 'precondition moved';

function outcomeOf(e: unknown, where: string): FileOutcome {
  if (e instanceof StaleStateError) return 'moved';
  if (e instanceof ChangesMismatchError) return 'moved';
  console.error(`${where}: ${String(e)}`);
  return 'trouble';
}

/* ------------------------------------------------------------------ *
 * What each door takes. The accept lists are what the picker offers;
 * the sets below are what the server actually believes. CNT-06 wants
 * the constraint said in words beside the control, so the sentence
 * lives here too — one place, so the control and the check cannot
 * drift apart and make a liar of the page.
 * ------------------------------------------------------------------ */

export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp';
export const PHOTO_LINE = 'A JPEG, PNG or WebP photograph, up to 2 MB.';
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const DECK_MAX_BYTES = 15 * 1024 * 1024;
export const DECK_ACCEPT = '.pdf,.pptx,.key,.zip';
export const DECK_LINE = 'A PDF, PowerPoint, Keynote or zip, up to 15 MB.';
const DECK_TYPE_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/vnd.apple.keynote',
  zip: 'application/zip',
};

/** A multipart envelope carries boundaries and field names as well as bytes,
 *  so the header check leaves room for them and the exact size is settled
 *  afterwards against the file itself. */
const ENVELOPE_SLACK = 16 * 1024;

/** Too large to be worth reading at all. Answered from the header, before the
 *  body is pulled into the isolate. */
export function tooLargeToRead(contentLength: string | undefined, max: number): boolean {
  const n = Number(contentLength ?? '');
  return Number.isFinite(n) && n > max + ENVELOPE_SLACK;
}

/** The part of a multipart form that is actually a file with bytes in it.
 *  Workers hands parseBody a File for a file part; an untouched picker comes
 *  through as a File of length nought, which is nobody sending anything. */
export function filePart(value: unknown): File | null {
  return value instanceof File && value.size > 0 ? value : null;
}

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** A name a browser gave us, made safe to keep and to print: no path, no
 *  control characters, and short enough to sit in a table cell. */
function safeName(raw: string, fallback: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let clean = '';
  for (const ch of base) if ((ch.codePointAt(0) ?? 0) >= 32) clean += ch;
  return clean.trim().slice(0, 120) || fallback;
}

const trimTo = (s: string, max: number): string => s.trim().slice(0, max);
const blank = (s: string): string | null => (s.trim() === '' ? null : s.trim());

/** The reply local-part for a task: get-or-create one short ticket per task
 *  (schema/0014), reused across every reminder. Returns `reply+<id>`, the
 *  local-part of the Reply-To a speaker or helper answers with the deck. */
export async function replyLocalPart(
  db: D1Database,
  taskId: string,
  speakerPersonId: string,
  nowMs: number = now()
): Promise<string | null> {
  const existing = await db
    .prepare('SELECT id FROM reply_ticket WHERE task_id = ?')
    .bind(taskId)
    .first<{ id: string }>();
  if (existing) return `reply+${existing.id}`;

  const id = newId('rt');
  try {
    await db
      .prepare('INSERT INTO reply_ticket (id, task_id, speaker_person_id, created_at) VALUES (?,?,?,?)')
      .bind(id, taskId, speakerPersonId, nowMs)
      .run();
    return `reply+${id}`;
  } catch {
    // A race created it first; read theirs.
    const row = await db
      .prepare('SELECT id FROM reply_ticket WHERE task_id = ?')
      .bind(taskId)
      .first<{ id: string }>();
    return row ? `reply+${row.id}` : null;
  }
}

/* ------------------------------------------------------------------ *
 * Reading one file back
 * ------------------------------------------------------------------ */

export type StoredFile = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: number;
};

export type FileRow = StoredFile & {
  ownerKind: 'submission' | 'person' | 'event';
  ownerId: string;
  r2Key: string;
};

export async function fileById(db: D1Database, id: string): Promise<FileRow | null> {
  const row = await db
    .prepare(
      `SELECT id, owner_kind, owner_id, filename, r2_key, content_type, size_bytes, uploaded_at
         FROM file WHERE id = ?`
    )
    .bind(id)
    .first<{
      id: string;
      owner_kind: 'submission' | 'person' | 'event';
      owner_id: string;
      filename: string;
      r2_key: string;
      content_type: string;
      size_bytes: number;
      uploaded_at: number;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    filename: row.filename,
    r2Key: row.r2_key,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    uploadedAt: row.uploaded_at,
  };
}

/** A photograph is the only thing here a stranger is meant to see: it goes on
 *  the public speaker page under the speaker's own name. Everything else is
 *  somebody's private working paper. The key says which. */
export const isPublicKey = (r2Key: string): boolean => r2Key.startsWith('headshots/');

/* ------------------------------------------------------------------ *
 * A photograph — SPK-08
 * ------------------------------------------------------------------ */

/**
 * Put this person's own photograph in place, and point their row at it.
 * Only ever their own row: personId comes from the session cookie and is
 * written into the SQL, never taken from the form.
 */
export async function saveHeadshot(
  db: D1Database,
  bucket: R2Bucket,
  personId: string,
  file: File
): Promise<FileOutcome> {
  const type = file.type.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!PHOTO_TYPES.has(type)) return 'wrong-kind';
  if (file.size > PHOTO_MAX_BYTES) return 'too-big';

  const key = `headshots/${personId}`;
  const existing = await db
    .prepare('SELECT id FROM file WHERE r2_key = ?')
    .bind(key)
    .first<{ id: string }>();
  const id = existing?.id ?? newId('fil');
  const name = safeName(file.name, 'photograph');
  const at = now();

  await bucket.put(key, file, { httpMetadata: { contentType: type } });

  try {
    await checkedBatch(
      db,
      existing
        ? [
            guard(db, 'SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM file WHERE id = ? AND r2_key = ?)', id, key),
            db
              .prepare(
                `UPDATE file
                    SET filename = ?, content_type = ?, size_bytes = ?, uploaded_at = ?,
                        uploaded_by_person_id = ?, replaced_at = NULL
                  WHERE id = ? AND r2_key = ?`
              )
              .bind(name, type, file.size, at, personId, id, key),
            db.prepare('UPDATE person SET headshot_file_id = ? WHERE id = ?').bind(id, personId),
          ]
        : [
            guard(db, 'SELECT 1 FROM file WHERE r2_key = ?', key),
            db
              .prepare(
                `INSERT INTO file (id, owner_kind, owner_id, filename, r2_key, content_type,
                                   size_bytes, uploaded_at, uploaded_by_person_id)
                 VALUES (?, 'person', ?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(id, personId, name, key, type, file.size, at, personId),
            db.prepare('UPDATE person SET headshot_file_id = ? WHERE id = ?').bind(id, personId),
          ],
      [0, 1, 1],
      STALE
    );
    return 'done';
  } catch (e) {
    // Only a key we have just brought into being is taken away again; a
    // replacement's key still belongs to the row that survived.
    if (!existing) await bucket.delete(key).catch(() => undefined);
    return outcomeOf(e, 'saveHeadshot');
  }
}

/* ------------------------------------------------------------------ *
 * A deck — CNT-02
 * ------------------------------------------------------------------ */

/**
 * Put a deck against one of this person's own file requests, and mark that
 * request done. Ownership is written into the SQL (portal-actions.ts's
 * discipline): the task must be theirs, must be a file request, and must not
 * have been called off.
 *
 * A finished request stays open to a second send on purpose — the corrected
 * deck lands on the same link, and completed_at moves to the day it actually
 * arrived rather than the day the first draft did.
 */
/**
 * CNT-04: every upload keeps the ones before it. `slides/{taskId}/{fileId}`
 * is a version's own key — nothing at it is ever overwritten — and
 * `{taskId}/` is the family a version list reads back by prefix. The batch
 * below is what keeps "at most one current row per family" true: it retires
 * the old current row (if any) and seats the new one in the same write, so a
 * reader can never catch two rows both claiming to be current.
 */
export async function saveDeck(
  db: D1Database,
  bucket: R2Bucket,
  personId: string,
  taskId: string,
  file: File
): Promise<FileOutcome> {
  const ext = extOf(file.name);
  const type = DECK_TYPE_BY_EXT[ext];
  if (!type) return 'wrong-kind';
  if (file.size > DECK_MAX_BYTES) return 'too-big';

  const task = await db
    .prepare(
      `SELECT id, submission_id FROM task
        WHERE id = ? AND person_id = ? AND kind = 'file_request' AND cancelled_at IS NULL`
    )
    .bind(taskId, personId)
    .first<{ id: string; submission_id: string | null }>();
  if (!task) return 'moved';

  // file.owner_kind takes three values and 'task' is not one of them (schema
  // 0001). A deck belongs to the talk it will be given for; a request with no
  // talk behind it belongs to the person who owes it. The task itself stays
  // findable either way, because the key names it.
  const ownerKind = task.submission_id ? 'submission' : 'person';
  const ownerId = task.submission_id ?? personId;

  const id = newId('fil');
  const key = `${DECK_PREFIX}${taskId}/${id}`;
  const name = safeName(file.name, `slides.${ext}`);
  const at = now();

  await bucket.put(key, file, { httpMetadata: { contentType: type } });

  const markDone = db
    .prepare(
      `UPDATE task SET completed_at = ?
        WHERE id = ? AND person_id = ? AND kind = 'file_request' AND cancelled_at IS NULL`
    )
    .bind(at, taskId, personId);

  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 FROM file WHERE r2_key = ?', key),
        db
          .prepare(`UPDATE file SET replaced_at = ? WHERE r2_key LIKE ? AND replaced_at IS NULL`)
          .bind(at, `${DECK_PREFIX}${taskId}/%`),
        db
          .prepare(
            `INSERT INTO file (id, owner_kind, owner_id, filename, r2_key, content_type,
                               size_bytes, uploaded_at, uploaded_by_person_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(id, ownerKind, ownerId, name, key, type, file.size, at, personId),
        markDone,
      ],
      [0, 'any', 1, 1],
      STALE
    );
    return 'done';
  } catch (e) {
    await bucket.delete(key).catch(() => undefined);
    return outcomeOf(e, 'saveDeck');
  }
}

/* ------------------------------------------------------------------ *
 * Finding a deck again
 * ------------------------------------------------------------------ */

const DECK_PREFIX = 'slides/';

type FileSqlRow = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  uploaded_at: number;
};

const toStored = (r: FileSqlRow): StoredFile => ({
  id: r.id,
  filename: r.filename,
  contentType: r.content_type,
  sizeBytes: r.size_bytes,
  uploadedAt: r.uploaded_at,
});

export type FileVersion = StoredFile & { replacedAt: number | null };

const toVersion = (r: FileSqlRow & { replaced_at: number | null }): FileVersion => ({
  ...toStored(r),
  replacedAt: r.replaced_at,
});

const VERSION_COLUMNS = 'id, filename, content_type, size_bytes, uploaded_at, replaced_at';
// Current first, then most recent first among the rest — the order every
// version list on this product reads in.
const VERSION_ORDER = 'ORDER BY replaced_at IS NOT NULL, uploaded_at DESC';

/**
 * The current deck behind a handful of file requests, by task. The key
 * carries the task, so this holds for a deck hung off a talk and one hung
 * off a person alike. D1 takes a bounded number of bindings and a portal
 * holds a handful of tasks, so the list is capped rather than paged.
 */
export async function decksForTasks(
  db: D1Database,
  taskIds: string[]
): Promise<Map<string, StoredFile>> {
  const out = new Map<string, StoredFile>();
  const ids = taskIds.slice(0, 50);
  if (ids.length === 0) return out;
  const results = await db.batch<FileSqlRow>(
    ids.map((id) =>
      db
        .prepare(
          `SELECT id, filename, content_type, size_bytes, uploaded_at
             FROM file WHERE r2_key LIKE ? AND replaced_at IS NULL LIMIT 1`
        )
        .bind(`${DECK_PREFIX}${id}/%`)
    )
  );
  ids.forEach((id, i) => {
    const row = results[i]?.results?.[0];
    if (row) out.set(id, toStored(row));
  });
  return out;
}

/** Every version of one deliverable, current first — CNT-04's version list. */
export async function deckVersions(db: D1Database, taskId: string): Promise<FileVersion[]> {
  const res = await db
    .prepare(`SELECT ${VERSION_COLUMNS} FROM file WHERE r2_key LIKE ? ${VERSION_ORDER}`)
    .bind(`${DECK_PREFIX}${taskId}/%`)
    .all<FileSqlRow & { replaced_at: number | null }>();
  return (res.results ?? []).map(toVersion);
}

/** The same, for a handful of tasks at once — a portal or a proposal reads
 *  several version lists on one page. Capped like decksForTasks. */
export async function deckVersionsForTasks(
  db: D1Database,
  taskIds: string[]
): Promise<Map<string, FileVersion[]>> {
  const out = new Map<string, FileVersion[]>();
  const ids = taskIds.slice(0, 50);
  if (ids.length === 0) return out;
  const results = await db.batch<FileSqlRow & { replaced_at: number | null }>(
    ids.map((id) =>
      db.prepare(`SELECT ${VERSION_COLUMNS} FROM file WHERE r2_key LIKE ? ${VERSION_ORDER}`).bind(`${DECK_PREFIX}${id}/%`)
    )
  );
  ids.forEach((id, i) => {
    const rows = results[i]?.results ?? [];
    if (rows.length) out.set(id, rows.map(toVersion));
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * The organizer's side of the same fact
 * ------------------------------------------------------------------ */

export type DeliverableRow = {
  taskId: string;
  title: string;
  dueOn: string | null;
  completedAt: number | null;
  personId: string;
  personName: string;
  submissionId: string | null;
  submissionTitle: string | null;
  file: StoredFile | null;
  versionCount: number;
};

/**
 * Every open deliverable request across one conference — one row per
 * request, not one per talk. A talk with two requests on it (a deck, a
 * headshot) used to collapse onto whichever due date sorted first, so a
 * board could show one request's status under the other's label; reading the
 * tasks themselves, with nothing standing between a row and the request it
 * is about, is what keeps that from happening again.
 *
 * queries/admin.ts's GreenRoomSession carries only the crew's own narrow
 * "are the slides in" fact and this parcel does not get to reshape that DTO,
 * so this is the narrow own-file read, in the same spirit as greenroom.ts's
 * own greenRoomNonceFor: one query, one screen.
 */
export async function deliverableRows(db: D1Database, eventId: string): Promise<DeliverableRow[]> {
  const res = await db
    .prepare(
      `SELECT t.id AS task_id, t.title, t.due_on, t.completed_at,
              t.person_id, pe.name AS person_name,
              t.submission_id, s.title AS submission_title,
              f.id AS file_id, f.filename, f.content_type, f.size_bytes, f.uploaded_at,
              (SELECT COUNT(*) FROM file f2
                WHERE f2.r2_key LIKE '${DECK_PREFIX}' || t.id || '/%') AS version_count
         FROM task t
         JOIN person pe ON pe.id = t.person_id
         LEFT JOIN submission s ON s.id = t.submission_id
         LEFT JOIN file f ON f.r2_key LIKE '${DECK_PREFIX}' || t.id || '/%' AND f.replaced_at IS NULL
        WHERE t.event_id = ? AND t.kind = 'file_request' AND t.cancelled_at IS NULL
        ORDER BY t.completed_at IS NOT NULL, t.due_on IS NULL, t.due_on, pe.name, t.title`
    )
    .bind(eventId)
    .all<{
      task_id: string;
      title: string;
      due_on: string | null;
      completed_at: number | null;
      person_id: string;
      person_name: string;
      submission_id: string | null;
      submission_title: string | null;
      file_id: string | null;
      filename: string | null;
      content_type: string | null;
      size_bytes: number | null;
      uploaded_at: number | null;
      version_count: number;
    }>();

  return (res.results ?? []).map((r) => ({
    taskId: r.task_id,
    title: r.title,
    dueOn: r.due_on,
    completedAt: r.completed_at,
    personId: r.person_id,
    personName: r.person_name,
    submissionId: r.submission_id,
    submissionTitle: r.submission_title,
    file:
      r.file_id !== null
        ? {
            id: r.file_id,
            filename: r.filename ?? 'The file',
            contentType: r.content_type ?? 'application/octet-stream',
            sizeBytes: r.size_bytes ?? 0,
            uploadedAt: r.uploaded_at ?? 0,
          }
        : null,
    versionCount: r.version_count,
  }));
}

/** How many decks this conference is still waiting on. The number the
 *  confirm names, and the number the guard then insists on. */
export async function stillWaitingCount(db: D1Database, eventId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM task
        WHERE event_id = ? AND kind = 'file_request'
          AND cancelled_at IS NULL AND completed_at IS NULL`
    )
    .bind(eventId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Still outstanding, on this conference, and this exact request.
const STILL_WAITING = `
  SELECT 1 FROM task
   WHERE id = ? AND event_id = ? AND kind = 'file_request'
     AND cancelled_at IS NULL AND completed_at IS NULL`;

/* ------------------------------------------------------------------ *
 * CNT-08: a reminder is a message, not a silent date move. Every "ask
 * again" writes a `message` row (kind 'reminder' — portal.ts already has a
 * label for it) inside the same guarded batch as the due-date update, so
 * the two facts can never land apart, and rides the identical after-commit
 * email step review.ts's nudgeReviewer and tasks.ts's releaseNotes use: real
 * addresses get real mail, the synthetic seed never leaves the building, and
 * a send that fails costs nothing because the portal is the copy of record.
 * ------------------------------------------------------------------ */

type EmailBinding = {
  send(msg: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
  }): Promise<unknown>;
};

const REMINDER_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "8 May" off a calendar-day string. Local to this file, like every other
 *  day-word in this build (greenroom.ts's dayShort, portal.ts's dShort). */
function dayWord(iso: string): string {
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return `${d} ${REMINDER_MONTHS[m - 1] ?? ''}`.trim();
}

function reminderSubject(titles: string[]): string {
  return titles.length === 1
    ? `Reminder: ${titles[0]}`
    : `Reminder: ${titles.length} deliverables still open`;
}

/** Names the outstanding deliverable(s) and the date they now owe it by — the
 *  exact two facts CNT-08's manual check reads for — and carries the link
 *  straight to the portal that answers them. A signed-out speaker or helper
 *  clicking it lands on the portal's sign-in, which returns them right back. */
export function reminderBody(titles: string[], eventName: string, dueOn: string, portalUrl: string): string {
  const said = dayWord(dueOn);
  const open = `Open your portal to send it: ${portalUrl}`;
  if (titles.length === 1) {
    return `${titles[0]} is still open on your list for ${eventName}, now due ${said}.\n\n${open}`;
  }
  const list = titles.map((t) => `- ${t}`).join('\n');
  return `These are still open on your list for ${eventName}, now due ${said}:\n\n${list}\n\n${open}`;
}

/** Fire-and-forget, after the row that makes it true is already committed —
 *  exactly tasks.ts's releaseNotes and review.ts's nudgeReviewer. A failed
 *  send costs nothing: the reminder is in the portal either way. */
function sendReminderEmail(
  db: D1Database,
  email: { binding: EmailBinding; from: string } | null,
  waitUntil: (p: Promise<unknown>) => void,
  messageId: string,
  to: string | null,
  name: string,
  subject: string,
  body: string,
  replyTo?: string
): void {
  if (!email || !to || !isRealAddress(to)) return;
  waitUntil(
    (async () => {
      try {
        await email.binding.send({
          to,
          from: { email: email.from, name: 'Fireside' },
          // A reply comes back to the deliverable, not to a black hole: reply
          // with the deck attached and it lands (workflows/reply-email.ts).
          ...(replyTo ? { replyTo } : {}),
          subject,
          text: `Hello ${name},\n\n${body}\n\n— sent from Fireside.`,
        });
        await db.prepare('UPDATE message SET emailed_at = ? WHERE id = ?').bind(now(), messageId).run();
      } catch {
        // the reminder is in their portal either way
      }
    })()
  );
}

/**
 * Ask one speaker again: the same request, a new date on it, and a reminder
 * naming the deliverable and the new date — staged and delivered in the same
 * write the due date moves in. One click, and undoable by asking again —
 * nothing else about the task moves, so a second press a week later is the
 * whole of the repair.
 */
export async function askAgain(
  db: D1Database,
  eventId: string,
  taskId: string,
  dueOn: string,
  email: { binding: EmailBinding; from: string } | null,
  waitUntil: (p: Promise<unknown>) => void,
  siteOrigin: string
): Promise<FileOutcome> {
  const before = await db
    .prepare(
      `SELECT t.title, pe.id AS person_id, pe.name AS person_name, pe.email AS person_email,
              ev.name AS event_name, ev.slug AS event_slug
         FROM task t
         JOIN person pe ON pe.id = t.person_id
         JOIN event ev ON ev.id = t.event_id
        WHERE t.id = ? AND t.event_id = ? AND t.kind = 'file_request'
          AND t.cancelled_at IS NULL AND t.completed_at IS NULL`
    )
    .bind(taskId, eventId)
    .first<{
      title: string;
      person_id: string;
      person_name: string;
      person_email: string | null;
      event_name: string;
      event_slug: string;
    }>();
  if (!before) return 'moved';

  const messageId = newId('msg');
  const t = now();
  const subject = reminderSubject([before.title]);
  const body = reminderBody([before.title], before.event_name, dueOn, `${siteOrigin}/${before.event_slug}/portal`);

  try {
    await checkedBatch(
      db,
      [
        guard(db, `SELECT 1 WHERE NOT EXISTS (${STILL_WAITING})`, taskId, eventId),
        db
          .prepare(
            `UPDATE task SET due_on = ?
              WHERE id = ? AND event_id = ? AND kind = 'file_request'
                AND cancelled_at IS NULL AND completed_at IS NULL`
          )
          .bind(dueOn, taskId, eventId),
        db
          .prepare(
            `INSERT INTO message (id, event_id, person_id, kind, subject, body, created_at, delivered_at)
             VALUES (?1, ?2, ?3, 'reminder', ?4, ?5, ?6, ?6)`
          )
          .bind(messageId, eventId, before.person_id, subject, body, t),
      ],
      [0, 1, 1],
      STALE
    );
  } catch (e) {
    return outcomeOf(e, 'askAgain');
  }

  // One reply address for this task, so a reply with the deck attached lands on
  // it — the same address to the speaker and to every helper, because the
  // inbound handler authorises by who is replying, not by the address.
  const localPart = await replyLocalPart(db, taskId, before.person_id);
  const replyTo = localPart ? `${localPart}@${new URL(siteOrigin).hostname}` : undefined;

  sendReminderEmail(db, email, waitUntil, messageId, before.person_email, before.person_name, subject, body, replyTo);
  // Whoever helps this speaker is kept in the loop: the same reminder, to each
  // of their helpers, so an assistant chasing the deck sees it too — and can
  // reply with the deck the same way the speaker can.
  for (const h of await helperContactsFor(db, eventId, before.person_id)) {
    sendReminderEmail(db, email, waitUntil, messageId, h.email, h.name, subject, body, replyTo);
  }
  return 'done';
}

/**
 * Ask everyone still owing, in one statement, with one reminder per speaker —
 * naming everything of theirs that moved, not one letter per deliverable.
 * `expected` is the number the confirm printed: the guard fires when the
 * world has moved since the page was drawn, so a screen that said "twelve"
 * can never quietly do fourteen, and the reminders sent are exactly the
 * reminders for the rows that guard let through.
 */
export async function askEveryoneWaiting(
  db: D1Database,
  eventId: string,
  dueOn: string,
  expected: number,
  email: { binding: EmailBinding; from: string } | null,
  waitUntil: (p: Promise<unknown>) => void,
  siteOrigin: string
): Promise<FileOutcome> {
  if (expected < 1) return 'moved';

  const waiting = await db
    .prepare(
      `SELECT t.title, pe.id AS person_id, pe.name AS person_name, pe.email AS person_email
         FROM task t
         JOIN person pe ON pe.id = t.person_id
        WHERE t.event_id = ? AND t.kind = 'file_request'
          AND t.cancelled_at IS NULL AND t.completed_at IS NULL`
    )
    .bind(eventId)
    .all<{ title: string; person_id: string; person_name: string; person_email: string | null }>();
  const rows = waiting.results ?? [];

  // One reminder per person, however many deliverables of theirs just moved —
  // nobody reads three letters that all say the same new date.
  const byPerson = new Map<string, { name: string; email: string | null; titles: string[] }>();
  for (const r of rows) {
    const entry = byPerson.get(r.person_id) ?? { name: r.person_name, email: r.person_email, titles: [] };
    entry.titles.push(r.title);
    byPerson.set(r.person_id, entry);
  }

  const event = await db
    .prepare('SELECT name, slug FROM event WHERE id = ?')
    .bind(eventId)
    .first<{ name: string; slug: string }>();
  const eventName = event?.name ?? '';
  const portalUrl = `${siteOrigin}/${event?.slug ?? ''}/portal`;
  const t = now();
  const messages = [...byPerson.entries()].map(([personId, info]) => ({
    id: newId('msg'),
    personId,
    info,
    subject: reminderSubject(info.titles),
    body: reminderBody(info.titles, eventName, dueOn, portalUrl),
  }));

  try {
    await checkedBatch(
      db,
      [
        guard(
          db,
          `SELECT 1 WHERE (SELECT COUNT(*) FROM task
              WHERE event_id = ? AND kind = 'file_request'
                AND cancelled_at IS NULL AND completed_at IS NULL) <> ?`,
          eventId,
          expected
        ),
        db
          .prepare(
            `UPDATE task SET due_on = ?
              WHERE event_id = ? AND kind = 'file_request'
                AND cancelled_at IS NULL AND completed_at IS NULL`
          )
          .bind(dueOn, eventId),
        ...messages.map((m) =>
          db
            .prepare(
              `INSERT INTO message (id, event_id, person_id, kind, subject, body, created_at, delivered_at)
               VALUES (?1, ?2, ?3, 'reminder', ?4, ?5, ?6, ?6)`
            )
            .bind(m.id, eventId, m.personId, m.subject, m.body, t)
        ),
      ],
      [0, expected, ...messages.map(() => 1 as const)],
      STALE
    );
  } catch (e) {
    return outcomeOf(e, 'askEveryoneWaiting');
  }

  for (const m of messages) {
    sendReminderEmail(db, email, waitUntil, m.id, m.info.email, m.info.name, m.subject, m.body);
    // Each speaker's helpers get the same letter, so an assistant is never the
    // last to know a due date moved.
    for (const h of await helperContactsFor(db, eventId, m.personId)) {
      sendReminderEmail(db, email, waitUntil, m.id, h.email, h.name, m.subject, m.body);
    }
  }
  return 'done';
}

/* ------------------------------------------------------------------ *
 * CNT: a per-deliverable share link (schema/0009), mirroring R-4's own
 * green-room shape (event.green_room_nonce) one deliverable at a time — an
 * AV or web crew member with the link opens the current file and its
 * version history with no Fireside sign-in, and rotating or clearing the
 * nonce is the entire revocation model, exactly as it is for the green room.
 * Keyed on the task rather than a file id, so a re-upload does not break the
 * link the organizer already handed out (see schema/0009's own note).
 * ------------------------------------------------------------------ */

export type ShareOutcome = 'made' | 'rotated' | 'revoked' | 'moved' | 'trouble';

/** The link's raw material — read only after the caller has proven EDIT_ROLES
 *  on the task's own event, the same narrow own-file exception greenroom.ts's
 *  greenRoomNonceFor takes for the same reason: one column, one screen. */
export async function fileShareNonceFor(db: D1Database, taskId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT share_nonce FROM task WHERE id = ?')
    .bind(taskId)
    .first<{ share_nonce: string | null }>();
  return row?.share_nonce ?? null;
}

/**
 * Make or rotate the link. `seen` is the nonce the screen was looking at —
 * if it had already changed, nothing is rotated and the outcome says so,
 * because rotating twice in a row would strand whoever just got the new one
 * (newGreenRoomLink's own reasoning, applied one deliverable at a time).
 */
export async function rotateFileShareLink(
  db: D1Database,
  taskId: string,
  seen: string | null
): Promise<ShareOutcome> {
  const held = seen && seen.trim() !== '' ? seen.trim() : null;
  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 FROM task WHERE id = ?1 AND share_nonce IS NOT ?2', taskId, held),
        db.prepare('UPDATE task SET share_nonce = ?2 WHERE id = ?1').bind(taskId, newId('fsh')),
      ],
      [0, 1],
      STALE
    );
  } catch (e) {
    const outcome = outcomeOf(e, 'rotateFileShareLink');
    return outcome === 'moved' ? 'moved' : 'trouble';
  }
  return held === null ? 'made' : 'rotated';
}

/** Clear the link. The same "seen" guard as rotating — a revoke that fires on
 *  a link nobody is looking at any more is not the one the organizer meant. */
export async function revokeFileShareLink(
  db: D1Database,
  taskId: string,
  seen: string
): Promise<ShareOutcome> {
  if (!seen.trim()) return 'moved';
  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 FROM task WHERE id = ?1 AND share_nonce IS NOT ?2', taskId, seen.trim()),
        db.prepare('UPDATE task SET share_nonce = NULL WHERE id = ?1').bind(taskId),
      ],
      [0, 1],
      STALE
    );
  } catch (e) {
    const outcome = outcomeOf(e, 'revokeFileShareLink');
    return outcome === 'moved' ? 'moved' : 'trouble';
  }
  return 'revoked';
}

export type DeliverableContext = {
  taskId: string;
  title: string;
  dueOn: string | null;
  eventId: string;
  eventName: string;
  eventTimezone: string;
  personName: string;
  submissionTitle: string | null;
  current: StoredFile | null;
  versions: FileVersion[];
};

/**
 * Everything a file-detail screen needs about the deliverable behind one
 * task: who it is for, what it is, the current file and every version of
 * it. The one read routes/files.ts's own /files/:id/detail and its public
 * /files/share/:nonce mirror share — the second resolves a nonce to a task
 * id and hands off to this, so the two screens can never disagree about
 * what a deliverable looks like.
 */
export async function deliverableContext(db: D1Database, taskId: string): Promise<DeliverableContext | null> {
  const row = await db
    .prepare(
      `SELECT t.id AS task_id, t.title, t.due_on, t.event_id, pe.name AS person_name,
              s.title AS submission_title, ev.name AS event_name, ev.timezone AS event_timezone
         FROM task t
         JOIN person pe ON pe.id = t.person_id
         JOIN event ev ON ev.id = t.event_id
         LEFT JOIN submission s ON s.id = t.submission_id
        WHERE t.id = ?`
    )
    .bind(taskId)
    .first<{
      task_id: string;
      title: string;
      due_on: string | null;
      event_id: string;
      person_name: string;
      submission_title: string | null;
      event_name: string;
      event_timezone: string;
    }>();
  if (!row) return null;

  const versions = await deckVersions(db, row.task_id);
  const current = versions.find((v) => v.replacedAt === null) ?? null;

  return {
    taskId: row.task_id,
    title: row.title,
    dueOn: row.due_on,
    eventId: row.event_id,
    eventName: row.event_name,
    eventTimezone: row.event_timezone,
    personName: row.person_name,
    submissionTitle: row.submission_title,
    current,
    versions,
  };
}

/**
 * The public read behind /files/share/:nonce — no Principal, same shape as
 * greenroom-token.ts's eventByGreenRoomNonce: an unknown or empty nonce
 * returns null and the route answers its own 404, never distinguishing
 * "wrong token" from "no such deliverable" for the caller.
 */
export async function deliverableByShareNonce(
  db: D1Database,
  nonce: string
): Promise<DeliverableContext | null> {
  const trimmed = nonce.trim();
  if (!trimmed) return null;
  const row = await db.prepare('SELECT id FROM task WHERE share_nonce = ?').bind(trimmed).first<{
    id: string;
  }>();
  if (!row) return null;
  return deliverableContext(db, row.id);
}

/* ------------------------------------------------------------------ *
 * The words beside the photograph — SPK-08
 * ------------------------------------------------------------------ */

export type ProfileFields = {
  name: string;
  jobTitle: string;
  organisation: string;
  bio: string;
  pronouns: string;
  links: string;
};

export const BIO_MAX = 900;

/** "Adeyemi, Naomi" — the sorting name the speaker gallery reads through
 *  COALESCE(sort_name, name). Kept in step here so that changing your name
 *  does not quietly move you to the wrong end of the list. */
function sortNameOf(name: string): string {
  const parts = name.split(/\s+/).filter((p) => p !== '');
  if (parts.length < 2) return name;
  return `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`;
}

/**
 * Save the words that go on the program. Their own row and no other — the id
 * is the session's, and it is written into the WHERE rather than trusted to
 * the form.
 */
export async function saveProfile(
  db: D1Database,
  personId: string,
  f: ProfileFields
): Promise<FileOutcome> {
  const name = trimTo(f.name, 120);
  if (name === '') return 'nothing';
  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM person WHERE id = ?)', personId),
        db
          .prepare(
            `UPDATE person
                SET name = ?, sort_name = ?, job_title = ?, organisation = ?, bio = ?,
                    pronouns = ?, links = ?
              WHERE id = ?`
          )
          .bind(
            name,
            sortNameOf(name),
            blank(trimTo(f.jobTitle, 120)),
            blank(trimTo(f.organisation, 120)),
            blank(trimTo(f.bio, BIO_MAX)),
            blank(trimTo(f.pronouns, 40)),
            blank(trimTo(f.links, 600)),
            personId
          ),
      ],
      [0, 1],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'saveProfile');
  }
}
