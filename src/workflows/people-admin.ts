// The organizer's own door onto three writes the speaker side already had,
// and one the product never had at all:
//
//   - a speaker's profile, made or changed by hand (SPK's own gap: a
//     proposal makes a person automatically; nothing else did until now).
//   - a proposal's title and abstract, corrected from the committee's side
//     instead of only the speaker's — the same replace-and-snapshot shape
//     workflows/edit.ts already keeps for a speaker's own edit, minus the
//     CFP window and the co-presenter reconciliation, which are that form's
//     business and not this one's.
//   - an existing ask's due date, title or instructions, so fixing a date
//     no longer means withdrawing the ask and asking again from scratch.
//
// Every write is EDIT_ROLES-scoped on the event (owner, approver, editor —
// never a reviewer, and never somebody with no standing here at all), and
// every write that touches an existing row is a guarded checkedBatch, the
// same discipline workflows/tasks.ts and workflows/edit.ts already keep.
// The headshot itself is never re-uploaded here: uploadSpeakerHeadshot adds
// only the event-scope guard and hands the bytes straight to workflows/
// files.ts's own saveHeadshot, so there is exactly one place a photograph
// ever lands.

import { checkedBatch, guard, newId, now, StaleStateError } from '../lib/db';
import { EDIT_ROLES, requireScope } from '../queries/admin';
import { FORMATS, LEVELS, tracksOfEvent, ABSTRACT_MAX } from './submit';
import { saveHeadshot, type FileOutcome } from './files';
import type { Principal } from './account';

const NAME_MAX = 120;
const JOB_MAX = 120;
const ORG_MAX = 120;
const BIO_MAX = 900;
const PRONOUNS_MAX = 40;
const LINKS_MAX = 600;
const TITLE_MAX = 200;
const TASK_TITLE_MAX = 140;
const INSTRUCTIONS_MAX = 2000;

const trimTo = (s: string, max: number): string => s.trim().slice(0, max);
const blank = (s: string): string | null => (s.trim() === '' ? null : s.trim());

/** "Adeyemi, Naomi" — mirrors workflows/files.ts's own sortNameOf, so a name
 *  typed in here sorts the gallery the same way a speaker's own edit would. */
function sortNameOf(name: string): string {
  const parts = name.split(/\s+/).filter((p) => p !== '');
  if (parts.length < 2) return name;
  return `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`;
}

/** A calendar day, and a real one — mirrors workflows/tasks.ts's own
 *  isCalendarDay, unexported there, small enough to keep here rather than
 *  widen that file's surface for one helper. */
function isCalendarDay(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/* ------------------------------------------------------------------ *
 * A speaker's own file, made or changed by hand — defect: no organizer-side
 * way to create a speaker or edit one's profile.
 * ------------------------------------------------------------------ */

export type PersonFields = {
  name: string;
  email: string;
  jobTitle: string;
  organisation: string;
  bio: string;
  pronouns: string;
  links: string;
};

export type PersonWriteResult =
  | { ok: true; personId: string }
  | { ok: false; code: 'no-name' | 'no-email' | 'taken' | 'not-found' | 'trouble' };

/**
 * A speaker who exists only because an organizer typed them in. Landing this
 * on the event's own roster (source 'manual' — the same table a CSV import
 * writes into, schema/0008) is what makes them show up on the People list
 * the moment this returns, with no proposal required first.
 */
export async function createSpeaker(
  db: D1Database,
  principal: Principal,
  eventId: string,
  input: PersonFields
): Promise<PersonWriteResult> {
  requireScope(principal, eventId, EDIT_ROLES);

  const name = trimTo(input.name, NAME_MAX);
  if (!name) return { ok: false, code: 'no-name' };
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) return { ok: false, code: 'no-email' };

  const existing = await db
    .prepare('SELECT id FROM person WHERE email = ? AND merged_into_id IS NULL')
    .bind(email)
    .first<{ id: string }>();
  if (existing) return { ok: false, code: 'taken' };

  const personId = newId('per');
  const t = now();
  try {
    await checkedBatch(
      db,
      [
        db
          .prepare(
            `INSERT INTO person (id, email, name, sort_name, job_title, organisation, bio,
                                  pronouns, links, share_contact, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,'{}',?)`
          )
          .bind(
            personId,
            email,
            name,
            sortNameOf(name),
            blank(trimTo(input.jobTitle, JOB_MAX)),
            blank(trimTo(input.organisation, ORG_MAX)),
            blank(trimTo(input.bio, BIO_MAX)),
            blank(trimTo(input.pronouns, PRONOUNS_MAX)),
            blank(trimTo(input.links, LINKS_MAX)),
            t
          ),
        db
          .prepare(
            `INSERT INTO roster_entry (id, event_id, person_id, source, created_at)
             VALUES (?,?,?,'manual',?)
             ON CONFLICT (event_id, person_id) DO NOTHING`
          )
          .bind(newId('ros'), eventId, personId, t),
      ],
      [1, 'any'],
      'that speaker already has a place on this list'
    );
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) {
      return { ok: false, code: 'taken' };
    }
    return { ok: false, code: 'trouble' };
  }
  return { ok: true, personId };
}

/**
 * Change what is already on a speaker's file. `personId` has to be somebody
 * this event actually knows — reached through a real proposal or through the
 * roster (schema/0008's roster_entry, the same fact rosterOnlyPersonDetail
 * reads in routes/admin/people.ts) — a stray id from another event's
 * directory is not this screen's to change.
 */
export async function updateSpeaker(
  db: D1Database,
  principal: Principal,
  eventId: string,
  personId: string,
  input: PersonFields
): Promise<PersonWriteResult> {
  requireScope(principal, eventId, EDIT_ROLES);

  const name = trimTo(input.name, NAME_MAX);
  if (!name) return { ok: false, code: 'no-name' };
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) return { ok: false, code: 'no-email' };

  const clash = await db
    .prepare('SELECT id FROM person WHERE email = ? AND id <> ? AND merged_into_id IS NULL')
    .bind(email, personId)
    .first<{ id: string }>();
  if (clash) return { ok: false, code: 'taken' };

  const ON_EVENT = `(
    SELECT 1 FROM roster_entry WHERE event_id = ?2 AND person_id = ?1
    UNION
    SELECT 1 FROM participation pa JOIN submission s ON s.id = pa.submission_id
     WHERE pa.person_id = ?1 AND s.event_id = ?2 AND s.state <> 'draft'
  )`;

  try {
    await checkedBatch(
      db,
      [
        guard(
          db,
          `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM person WHERE id = ?1 AND merged_into_id IS NULL)
              OR NOT EXISTS ${ON_EVENT}`,
          personId,
          eventId
        ),
        db
          .prepare(
            `UPDATE person
                SET name = ?, sort_name = ?, email = ?, job_title = ?, organisation = ?,
                    bio = ?, pronouns = ?, links = ?
              WHERE id = ? AND merged_into_id IS NULL`
          )
          .bind(
            name,
            sortNameOf(name),
            email,
            blank(trimTo(input.jobTitle, JOB_MAX)),
            blank(trimTo(input.organisation, ORG_MAX)),
            blank(trimTo(input.bio, BIO_MAX)),
            blank(trimTo(input.pronouns, PRONOUNS_MAX)),
            blank(trimTo(input.links, LINKS_MAX)),
            personId
          ),
      ],
      [0, 1],
      'that record moved while you were looking'
    );
  } catch (e) {
    if (e instanceof StaleStateError) return { ok: false, code: 'not-found' };
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) {
      return { ok: false, code: 'taken' };
    }
    return { ok: false, code: 'trouble' };
  }
  return { ok: true, personId };
}

export type SpeakerHeadshotOutcome = FileOutcome | 'not-here';

/**
 * The photograph half of the same file, kept its own act on purpose (the
 * same split SPK-08's portal profile card keeps): a two-megabyte upload
 * should never have to travel again to fix a typo in a job title. Adds only
 * the event-scope guard on top of workflows/files.ts's own saveHeadshot,
 * which already owns the bucket write, the size and kind checks, and the
 * row that points person.headshot_file_id at it — reused whole, not
 * reinvented.
 */
export async function uploadSpeakerHeadshot(
  db: D1Database,
  bucket: R2Bucket,
  principal: Principal,
  eventId: string,
  personId: string,
  file: File
): Promise<SpeakerHeadshotOutcome> {
  requireScope(principal, eventId, EDIT_ROLES);
  const onEvent = await db
    .prepare(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM roster_entry WHERE event_id = ? AND person_id = ?)
          OR EXISTS (SELECT 1 FROM participation pa JOIN submission s ON s.id = pa.submission_id
                      WHERE pa.person_id = ? AND s.event_id = ? AND s.state <> 'draft')`
    )
    .bind(eventId, personId, personId, eventId)
    .first();
  if (!onEvent) return 'not-here';
  return saveHeadshot(db, bucket, personId, file);
}

/* ------------------------------------------------------------------ *
 * A proposal's own words, corrected from the committee's side — defect: no
 * organizer-side editing of a session's title or abstract anywhere in the
 * admin. Same replace-and-snapshot shape as workflows/edit.ts's
 * editProposal, minus the CFP window (an organizer is not bound by when the
 * call closes) and the co-presenter block (that stays the speaker's own).
 * ------------------------------------------------------------------ */

export type SubmissionFields = {
  title: string;
  abstract: string;
  format: string;
  level: string;
  /** '' means no track. */
  trackSlug: string;
};

export type SubmissionWriteResult =
  | { ok: true }
  | { ok: false; code: 'no-title' | 'too-long' | 'not-here' | 'trouble' };

export async function editSubmissionWords(
  db: D1Database,
  principal: Principal,
  eventId: string,
  submissionId: string,
  input: SubmissionFields
): Promise<SubmissionWriteResult> {
  requireScope(principal, eventId, EDIT_ROLES);

  const title = trimTo(input.title, TITLE_MAX);
  if (!title) return { ok: false, code: 'no-title' };
  const abstract = input.abstract.trim();
  if (abstract.length > ABSTRACT_MAX) return { ok: false, code: 'too-long' };

  const current = await db
    .prepare(
      `SELECT s.title, s.abstract, s.format, s.level, s.requested_min, t.slug AS track_slug
         FROM submission s LEFT JOIN track t ON t.id = s.track_id
        WHERE s.id = ? AND s.event_id = ?`
    )
    .bind(submissionId, eventId)
    .first<{
      title: string;
      abstract: string | null;
      format: string;
      level: string | null;
      requested_min: number;
      track_slug: string | null;
    }>();
  if (!current) return { ok: false, code: 'not-here' };

  const chosenFormat = FORMATS.find((f) => f.word === input.format);
  const format = chosenFormat ? chosenFormat.word : current.format;
  const minutes = chosenFormat ? chosenFormat.minutes : current.requested_min;
  const chosenLevel = LEVELS.find((l) => l.value === input.level);
  const level = chosenLevel ? chosenLevel.value : current.level;

  let trackId: string | null = null;
  if (input.trackSlug !== '') {
    const tracks = await tracksOfEvent(db, eventId);
    trackId = tracks.find((t) => t.slug === input.trackSlug)?.id ?? null;
  }

  // The words about to be replaced, kept whole — the same revision table and
  // the same "copy first, replace after, one batch" rule editProposal keeps,
  // so an organizer's correction is no less recoverable than a speaker's own.
  const previousBody = JSON.stringify({
    title: current.title,
    abstract: current.abstract,
    format: current.format,
    level: current.level,
    track: current.track_slug,
  });

  try {
    await checkedBatch(
      db,
      [
        guard(
          db,
          'SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM submission WHERE id = ?1 AND event_id = ?2)',
          submissionId,
          eventId
        ),
        db
          .prepare(
            `INSERT INTO revision (id, owner_kind, owner_id, body, source, created_at, author_id)
             VALUES (?, 'submission', ?, ?, 'organizer_edit', ?, ?)`
          )
          .bind(newId('rev'), submissionId, previousBody, now(), principal.personId),
        db
          .prepare(
            `UPDATE submission
                SET title = ?, abstract = ?, format = ?, level = ?, track_id = ?, requested_min = ?
              WHERE id = ? AND event_id = ?`
          )
          .bind(title, blank(abstract), format, level, trackId, minutes, submissionId, eventId),
      ],
      [0, 1, 1],
      'that proposal moved while you were looking'
    );
  } catch (e) {
    if (e instanceof StaleStateError) return { ok: false, code: 'not-here' };
    return { ok: false, code: 'trouble' };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Changing an ask already on somebody's list — defect: an ask can only be
 * withdrawn, so fixing a due date meant deleting one and asking again.
 * ------------------------------------------------------------------ */

export type TaskFields = { title: string; dueOn: string; instructions: string };

export type TaskWriteResult = { ok: true } | { ok: false; code: 'no-title' | 'bad-date' | 'gone' | 'trouble' };

/** Only an open ask can be changed — one already done or withdrawn is a
 *  thing that happened, the same rule cancelTask (workflows/tasks.ts) holds
 *  a withdrawal to. */
export async function editTask(
  db: D1Database,
  principal: Principal,
  eventId: string,
  taskId: string,
  input: TaskFields
): Promise<TaskWriteResult> {
  requireScope(principal, eventId, EDIT_ROLES);

  const title = trimTo(input.title, TASK_TITLE_MAX);
  if (!title) return { ok: false, code: 'no-title' };
  const dueRaw = input.dueOn.trim();
  if (dueRaw !== '' && !isCalendarDay(dueRaw)) return { ok: false, code: 'bad-date' };
  const dueOn = dueRaw === '' ? null : dueRaw;
  const instructions = blank(trimTo(input.instructions, INSTRUCTIONS_MAX));

  const OPEN = `SELECT 1 FROM task
    WHERE id = ?1 AND event_id = ?2 AND completed_at IS NULL AND cancelled_at IS NULL`;

  try {
    await checkedBatch(
      db,
      [
        guard(db, `SELECT 1 WHERE NOT EXISTS (${OPEN})`, taskId, eventId),
        db
          .prepare(
            `UPDATE task SET title = ?, due_on = ?, instructions = ?
              WHERE id = ? AND event_id = ? AND completed_at IS NULL AND cancelled_at IS NULL`
          )
          .bind(title, dueOn, instructions, taskId, eventId),
      ],
      [0, 1],
      'that ask changed while you were looking'
    );
  } catch (e) {
    if (e instanceof StaleStateError) return { ok: false, code: 'gone' };
    return { ok: false, code: 'trouble' };
  }
  return { ok: true };
}
