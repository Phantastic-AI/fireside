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

/**
 * Ask one speaker again: the same request, a new date on it. One click, and
 * undoable by asking again — nothing else about the task moves, so a second
 * press a week later is the whole of the repair.
 */
export async function askAgain(
  db: D1Database,
  eventId: string,
  taskId: string,
  dueOn: string
): Promise<FileOutcome> {
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
      ],
      [0, 1],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'askAgain');
  }
}

/**
 * Ask everyone still owing, in one statement. `expected` is the number the
 * confirm printed: the guard fires when the world has moved since the page was
 * drawn, so a screen that said "twelve" can never quietly do fourteen.
 */
export async function askEveryoneWaiting(
  db: D1Database,
  eventId: string,
  dueOn: string,
  expected: number
): Promise<FileOutcome> {
  if (expected < 1) return 'moved';
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
      ],
      [0, expected],
      STALE
    );
    return 'done';
  } catch (e) {
    return outcomeOf(e, 'askEveryoneWaiting');
  }
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
