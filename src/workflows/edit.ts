// Changing a proposal after it is sent — the only writer behind the edit form.
//
// The thanks page makes a promise ("you can change every word until the call
// closes"), and this is the file that keeps it. Priya is fixing her abstract at
// 23:50 the night before the call closes, so three things have to be true:
//
//  1. THE WINDOW IS THE DATABASE'S JOB, NOT THE SCREEN'S. The call being open
//     and the proposal being one the committee has not acted on are both
//     re-checked inside the batch, at write time, by guards — a page opened at
//     23:58 and saved at 00:01 must not slip through.
//  2. NOTHING IS OVERWRITTEN WITHOUT A COPY. The words being replaced are
//     snapshotted into `revision` in the same batch that replaces them, so the
//     two can never disagree.
//  3. A REFUSAL NEVER LEAKS A DECISION. When the guard fires we say the
//     proposal moved and nothing more: a decision that has been made but not
//     sent is invisible to the speaker (02 §1.3), and "the committee has
//     accepted this" is not a thing this file is allowed to say.
//
// Validation mirrors workflows/submit.ts field for field — same ceiling, same
// vocabulary, same sentences — minus name and email, which are the person's,
// not the proposal's, and live in the portal.
//
// It also owns `trueStanding` — the one read in the speaker's half of the
// product that sees a decision before it is told. Nothing it returns is ever
// printed: it exists so the door can be the same shape as the lock behind it.

import {
  ChangesMismatchError,
  StaleStateError,
  checkedBatch,
  guard,
  newId,
  type Expected,
} from '../lib/db';
import {
  ABSTRACT_MAX,
  FORMATS,
  LEVELS,
  coParticipation,
  peopleOnTalk,
  planCoPresenters,
  readCoPresenters,
  tracksOfEvent,
  visibleQuestions,
  type CoRow,
} from './submit';
import type { CfpQuestion } from '../queries/public';

/** What the edit form posts. Identity is not on it — only the talk. */
export type EditInput = {
  title: string;
  abstract: string;
  trackSlug: string;
  format: string;
  level: string;
  /** R-10 answers as posted, keyed by question id. */
  answers: Record<string, string | boolean>;
  /** The call's own questions, so visibility and required-ness are judged once. */
  questions: readonly CfpQuestion[];
  /**
   * The people speaking with them, as the form posted them — the whole block,
   * because this writer reconciles: an address that has gone off the form goes
   * off the talk. Absent means the form never asked, and then nobody moves.
   */
  co?: readonly CoRow[];
};

/** The states a submission can really be in. Kept here beside the one read
 *  that is allowed to see them. */
export type TrueState =
  | 'draft'
  | 'submitted'
  | 'accepted'
  | 'waitlisted'
  | 'rejected'
  | 'withdrawn'
  | 'cancelled';

/** Where a talk really stands, and whether the letter has gone. */
export type TrueStanding = { state: TrueState; told: boolean };

/**
 * The submission's own standing, read straight.
 *
 * queries/portal.ts cannot answer this and should not: it hides a decision
 * nobody has been told about, which is the product's own promise. But a door
 * that reads the hidden state draws an editable form over a proposal the write
 * guard will refuse, and then refuses it in the wrong words. So the screen
 * reads the truth to decide what to draw, and prints none of it.
 *
 * Scoped to one event and to one person on the talk, so it answers only about
 * a proposal that is already theirs.
 */
export async function trueStanding(
  db: D1Database,
  eventId: string,
  submissionId: string,
  personId: string
): Promise<TrueStanding | null> {
  const row = await db
    .prepare(
      `SELECT s.state, s.notified_at
         FROM submission s
         JOIN participation pa ON pa.submission_id = s.id AND pa.person_id = ?
        WHERE s.id = ? AND s.event_id = ?`
    )
    .bind(personId, submissionId, eventId)
    .first<{ state: TrueState; notified_at: number | null }>();
  return row ? { state: row.state, told: row.notified_at !== null } : null;
}

export type EditOutcome =
  /** Saved. */
  | { ok: true }
  /** A sentence for the form to say, and the control to send them back to. */
  | { ok: false; kind: 'refused'; field: string | null; message: string }
  /** The window shut, or the proposal is no longer theirs to change. */
  | { ok: false; kind: 'moved' }
  /** Nothing was written and nothing is known about why. */
  | { ok: false; kind: 'trouble' };

const norm = (s: string): string => s.trim();
const count = (n: number): string => n.toLocaleString('en-US');

/** The answers worth keeping: visible questions only, blanks dropped. */
function keptAnswers(
  visible: readonly CfpQuestion[],
  answers: Record<string, string | boolean>
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const q of visible) {
    const raw = answers[q.id];
    if (q.kind === 'checkbox') {
      out[q.id] = raw === true || raw === 'true';
      continue;
    }
    const text = typeof raw === 'string' ? norm(raw) : '';
    if (text) out[q.id] = text;
  }
  return out;
}

function asObject(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

type CurrentRow = {
  title: string;
  abstract: string | null;
  format: string;
  level: string | null;
  extra: string;
  track_slug: string | null;
  mine: number;
};

const refuse = (field: string | null, message: string): EditOutcome => ({
  ok: false,
  kind: 'refused',
  field,
  message,
});

/**
 * Replace the words on one proposal, keeping the ones being replaced.
 *
 * `personId` is the speaker doing the editing; the batch re-checks that they
 * are still on the proposal, so a co-speaker taken off it mid-edit cannot
 * write. Refusals come back as sentences rather than exceptions, because being
 * told "a title is needed" is a normal thing for a form to say.
 *
 * The people on it move in the same batch as the words: an address typed into
 * the block joins the talk, an address rubbed out leaves it, and both happen
 * or neither does.
 */
export async function editProposal(
  db: D1Database,
  eventId: string,
  submissionId: string,
  personId: string,
  input: EditInput,
  nowMs: number = Date.now()
): Promise<EditOutcome> {
  const title = norm(input.title);
  const abstract = norm(input.abstract);

  if (!title) {
    return refuse('f-title', 'A title is needed — it is the line the committee reads first.');
  }
  if (!abstract) {
    return refuse(
      'f-abs',
      'A paragraph about the talk is needed. Two or three sentences are plenty to start with.'
    );
  }
  if (abstract.length > ABSTRACT_MAX) {
    return refuse(
      'f-abs',
      `The paragraph runs to ${count(abstract.length)} characters and the program has room for ` +
        `${count(ABSTRACT_MAX)}. Cut the setup, keep the numbers.`
    );
  }

  const chosenFormat = FORMATS.find((f) => f.word === input.format);
  if (!chosenFormat) {
    return refuse('f-fmt', 'Choose a format so the grid knows how long to leave you.');
  }
  const chosenLevel = LEVELS.find((l) => l.value === input.level);
  if (!chosenLevel) {
    return refuse('f-lvl', 'Say who the talk is for, so nobody walks into the wrong room.');
  }

  const tracks = await tracksOfEvent(db, eventId);
  let trackId: string | null = null;
  if (tracks.length) {
    const chosen = tracks.find((t) => t.slug === input.trackSlug);
    if (!chosen) {
      return refuse('f-track', 'Pick the part of the program your talk belongs in.');
    }
    trackId = chosen.id;
  }

  const builtIns = { format: chosenFormat.word, track: input.trackSlug, level: chosenLevel.value };
  const visible = visibleQuestions(input.questions, builtIns, input.answers);
  const kept = keptAnswers(visible, input.answers);
  for (const q of visible) {
    if (!q.required) continue;
    const given = kept[q.id];
    if (given === undefined || given === false || given === '') {
      return refuse(`f-q-${q.id}`, `${q.label} is one the organizers ask everyone.`);
    }
  }

  // Who is on it now, so a row already there is left alone and a row that has
  // gone off the form can be taken off the talk. Everyone's address counts as
  // taken, whatever their standing: a speaker cannot demote the person whose
  // proposal it is by typing them into a co-presenter row.
  const onIt = await peopleOnTalk(db, submissionId);
  const coReading = readCoPresenters(
    input.co ?? [],
    onIt.map((p) => p.email ?? '')
  );
  if (!coReading.ok) return refuse(coReading.field, coReading.message);

  // Reconciliation only happens when the form actually carried the block —
  // a caller that says nothing about co-presenters removes none of them.
  const asked = input.co !== undefined;
  const stays = new Set(coReading.posted);
  const goodbye = asked
    ? onIt.filter(
        (p) =>
          p.role !== 'speaker' &&
          !p.isSubmitter &&
          p.email !== null &&
          !stays.has(p.email.toLowerCase())
      )
    : [];
  // Kept people whose role changed on their row (T604): the same upsert the
  // arrivals use, which touches role and position and can never reach the
  // submitter's own standing.
  const rerolled = asked
    ? onIt.filter(
        (p) =>
          p.role !== 'speaker' &&
          !p.isSubmitter &&
          p.email !== null &&
          stays.has(p.email.toLowerCase()) &&
          coReading.postedRoles[p.email.toLowerCase()] !== undefined &&
          coReading.postedRoles[p.email.toLowerCase()] !== p.role
      )
    : [];
  const arrivals = await planCoPresenters(db, coReading.fresh, nowMs);

  // The words about to be replaced, read as late as possible so the copy kept
  // is the one that was really there.
  const before = await db
    .prepare(
      `SELECT s.title, s.abstract, s.format, s.level, s.extra, t.slug AS track_slug,
              EXISTS (SELECT 1 FROM participation pa
                       WHERE pa.submission_id = s.id AND pa.person_id = ?) AS mine
         FROM submission s
         LEFT JOIN track t ON t.id = s.track_id
        WHERE s.id = ? AND s.event_id = ?`
    )
    .bind(personId, submissionId, eventId)
    .first<CurrentRow>();
  if (!before || before.mine !== 1) return { ok: false, kind: 'moved' };

  const previousBody = JSON.stringify({
    title: before.title,
    abstract: before.abstract,
    track: before.track_slug,
    format: before.format,
    level: before.level,
    extra: asObject(before.extra),
  });

  const statements: D1PreparedStatement[] = [
    // The call is still open — re-read inside the batch, at write time.
    guard(
      db,
      `SELECT 1 FROM event WHERE id = ?
         AND (cfp_closes_at IS NULL OR cfp_closes_at <= ?
              OR (cfp_opens_at IS NOT NULL AND cfp_opens_at > ?))`,
      eventId,
      nowMs,
      nowMs
    ),
    // Still unacted-on, and still theirs. Both facts, one guard: either way the
    // screen says the same sentence, so neither can be read off the other.
    guard(
      db,
      `SELECT 1 FROM submission s WHERE s.id = ? AND s.event_id = ?
         AND (s.state NOT IN ('draft','submitted')
              OR NOT EXISTS (SELECT 1 FROM participation pa
                              WHERE pa.submission_id = s.id AND pa.person_id = ?))`,
      submissionId,
      eventId,
      personId
    ),
    db
      .prepare(
        `INSERT INTO revision (id, owner_kind, owner_id, body, source, created_at)
         VALUES (?, 'submission', ?, ?, 'edit', ?)`
      )
      .bind(newId('rev'), submissionId, previousBody, nowMs),
    db
      .prepare(
        `UPDATE submission
            SET title = ?, abstract = ?, format = ?, track_id = ?, level = ?,
                requested_min = ?, extra = ?
          WHERE id = ? AND event_id = ? AND state IN ('draft','submitted')`
      )
      .bind(
        title,
        abstract,
        chosenFormat.word,
        trackId,
        chosenLevel.value,
        chosenFormat.minutes,
        JSON.stringify(kept),
        submissionId,
        eventId
      ),
  ];
  // Two guards that touch nothing, the copy kept, the words replaced.
  const expect: Expected[] = [0, 0, 1, 1];

  // Anyone new on the talk: the person first, then the row pointing at them.
  for (const mate of arrivals) {
    if (mate.create) {
      statements.push(mate.create);
      expect.push(1);
    }
  }
  for (const mate of arrivals) {
    statements.push(
      coParticipation(
        db,
        submissionId,
        mate.personId,
        coReading.posted.indexOf(mate.email) + 1,
        coReading.postedRoles[mate.email] ?? 'co_speaker'
      )
    );
    expect.push(1);
  }
  // Role changes for people already on the talk — same upsert, same wall.
  for (const p of rerolled) {
    const email = (p.email ?? '').toLowerCase();
    statements.push(
      coParticipation(
        db,
        submissionId,
        p.personId,
        coReading.posted.indexOf(email) + 1,
        coReading.postedRoles[email] ?? 'co_speaker'
      )
    );
    expect.push(1);
  }

  // Anyone taken off it. Only a co-presenter's own row, and never the row that
  // says whose proposal this is — the statement says so itself, so a posted
  // address can never reach a standing this form does not hand out. Somebody
  // an organizer put on without an address was never in the block to begin
  // with, and does not fall out from behind it either.
  for (const gone of goodbye) {
    statements.push(
      db
        .prepare(
          `DELETE FROM participation
            WHERE submission_id = ? AND person_id = ?
              AND role <> 'speaker' AND is_submitter = 0`
        )
        .bind(submissionId, gone.personId)
    );
    expect.push(1);
  }

  try {
    await checkedBatch(
      db,
      statements,
      expect,
      'that proposal moved while this page was open'
    );
  } catch (e) {
    if (e instanceof StaleStateError || e instanceof ChangesMismatchError) {
      return { ok: false, kind: 'moved' };
    }
    return { ok: false, kind: 'trouble' };
  }

  return { ok: true };
}
