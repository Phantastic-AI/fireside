// Sending a proposal. The only writer behind the call for speakers.
//
// Three rules shape everything here:
//
//  1. NO ACCOUNT UNTIL YOU PRESS SEND. A proposal identifies its author by
//     email address, so this workflow finds-or-creates a Person the same way
//     account.ts does — but never sets a password and never mints a session.
//     A stranger who types someone else's address gains nothing: the portal
//     link and the decision go to the address, not to the browser.
//  2. THE CAP IS THE DATABASE'S JOB, NOT THE SCREEN'S. max_submissions is
//     re-checked inside the batch by a guard, so two tabs racing each other
//     cannot both slip past the reading done a moment earlier.
//  3. WORDS COME FROM THE LABEL MAP. `format` is stored as the canonical word
//     (that is the vocabulary CP0's seed wrote and the vocabulary the R-10
//     show-if conditions compare against), and that word is read from
//     lib/labels.ts rather than typed here — so one edit still moves both.
//
// Everything the committee is sent lands in one batch: the person (when new),
// the submission, and the participation row that says whose it is.

import { checkedBatch, guard, newId, StaleStateError } from '../lib/db';
import { label } from '../lib/labels';
import { findPersonByEmail } from './account';
import type { CfpQuestion } from '../queries/public';

/** The abstract goes on the program word for word, so it has a real ceiling. */
export const ABSTRACT_MAX = 1200;

/**
 * The formats a call offers, the word each one is stored as, and the length it
 * asks the grid for. `word` is the value posted, the value stored, and the
 * value an R-10 show-if condition compares against — one string, three jobs.
 */
export const FORMATS: readonly { word: string; minutes: number }[] = [
  { word: label('format.talk', 'onstage'), minutes: 30 },
  { word: label('format.workshop', 'onstage'), minutes: 90 },
  { word: label('format.panel', 'onstage'), minutes: 45 },
  { word: label('format.lightning', 'onstage'), minutes: 15 },
];

/**
 * Who a talk is pitched at. The stored value is the enum CP0's seed wrote;
 * the word beside it is the label map's, and only the word is ever rendered.
 */
export const LEVELS: readonly { value: string; word: string }[] = [
  { value: 'intro', word: label('level.new', 'onstage') },
  { value: 'practitioner', word: label('level.working', 'onstage') },
  { value: 'deep', word: label('level.deep', 'onstage') },
];

export type TrackOption = { id: string; slug: string; name: string; colour: string };

/** What the speaker typed. Words as typed; trimming happens here, not upstream. */
export type ProposalInput = {
  title: string;
  abstract: string;
  trackSlug: string;
  format: string;
  level: string;
  name: string;
  email: string;
  organisation: string;
  /** R-10 answers as posted, keyed by question id. */
  answers: Record<string, string | boolean>;
  /** The call's own questions, so visibility and required-ness are judged once. */
  questions: readonly CfpQuestion[];
  /** The people speaking with them, as typed. Absent means the form never
   *  asked — a caller that does not carry the block changes nobody. */
  co?: readonly CoRow[];
};

export type SubmitRefusal = {
  ok: false;
  /** Which control to send them back to. Null when the refusal is about the call itself. */
  field: string | null;
  /** A whole sentence, in the speaker's register. Screens render it as written. */
  message: string;
};

export type SubmitOutcome =
  | { ok: true; submissionId: string; personId: string; email: string }
  | SubmitRefusal;

const norm = (s: string): string => s.trim();
const lower = (s: string): string => s.trim().toLowerCase();

/** A plain reading of an address: something, an @, something with a dot in it. */
function looksLikeAnAddress(email: string): boolean {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email);
}

/* ------------------------------------------------------------------ *
 * The people speaking with you
 *
 * Plenty of talks are two people, and a program that prints one of them is
 * wrong in public and awkward in person. So the form takes them by name and
 * address — the address because that is what turns a name into somebody with
 * a portal of their own, through the same find-or-create the submitter's own
 * address goes through, and under the same rule: a person, never an account.
 *
 * Both writers share this machinery. Sending a proposal only ever adds; the
 * edit form reconciles, and does it by address, so the person on the row is
 * the person on the program.
 * ------------------------------------------------------------------ */

/** Empty rows a fresh form draws. */
export const CO_ROWS = 3;

/**
 * How many rows a posted form is read for. It is wider than CO_ROWS because
 * the edit form draws one row per person already on the talk — an organizer
 * may have added a fourth backstage — and every person a form can show has to
 * be a person that form can also take off.
 */
export const CO_WINDOW = 8;

/** One row of the block, exactly as it was typed. */
export type CoRow = { name: string; email: string };

/** The rows off a posted body. The names are the form's: co_name_1, co_email_1. */
export function coRowsFrom(read: (key: string) => string, upTo: number = CO_WINDOW): CoRow[] {
  const rows: CoRow[] = [];
  for (let i = 1; i <= upTo; i++) {
    rows.push({ name: read(`co_name_${i}`), email: read(`co_email_${i}`) });
  }
  return rows;
}

/** How a refusal points at a row when there is no name in it yet to point at. */
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

export type CoReading =
  | {
      ok: true;
      /** Every complete row's address, in the order typed — what the talk should end with. */
      posted: string[];
      /** The ones not on the talk already: these are the rows that mean work. */
      fresh: { name: string; email: string }[];
    }
  | { ok: false; field: string; message: string };

/**
 * Read the block. A row with nothing in it is somebody who was never there;
 * a half-written row is somebody the speaker meant, so it is named back to
 * them rather than quietly dropped. `taken` is the addresses already on the
 * talk — those rows are left alone, which is what makes saving an untouched
 * form a no-op.
 */
export function readCoPresenters(rows: readonly CoRow[], taken: readonly string[]): CoReading {
  const already = new Set(taken.map((e) => lower(e)).filter((e) => e !== ''));
  const posted: string[] = [];
  const fresh: { name: string; email: string }[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    if (!raw) continue;
    const name = norm(raw.name);
    const email = lower(raw.email);
    if (!name && !email) continue;
    const where = ORDINALS[i] ?? 'last';
    if (!name) {
      return {
        ok: false,
        field: `f-co-name-${i + 1}`,
        message: `The ${where} person on this one needs a name — the name is what goes on the program beside yours.`,
      };
    }
    if (!looksLikeAnAddress(email)) {
      return {
        ok: false,
        field: `f-co-email-${i + 1}`,
        message: `We cannot read the address next to ${name}. It is how they reach their own portal, so it has to be one that works.`,
      };
    }
    if (seen.has(email)) continue;
    seen.add(email);
    posted.push(email);
    if (!already.has(email)) fresh.push({ name, email });
  }

  return { ok: true, posted, fresh };
}

/** A person to put on the talk, and the row that has to exist first. */
export type CoPlan = {
  personId: string;
  name: string;
  email: string;
  /** Null when the address is already somebody. */
  create: D1PreparedStatement | null;
};

/**
 * Find-or-create, the submitter's own path exactly: no password, no session,
 * nothing to sign in with until they ask for a link at the address given.
 */
export async function planCoPresenters(
  db: D1Database,
  rows: readonly { name: string; email: string }[],
  nowMs: number
): Promise<CoPlan[]> {
  const plans: CoPlan[] = [];
  for (const row of rows) {
    const person = await findPersonByEmail(db, row.email);
    if (person) {
      plans.push({ personId: person.id, name: row.name, email: row.email, create: null });
      continue;
    }
    const personId = newId('per');
    plans.push({
      personId,
      name: row.name,
      email: row.email,
      create: db
        .prepare(
          `INSERT INTO person (id, email, name, sort_name, share_contact, created_at)
           VALUES (?,?,?,?,'{}',?)`
        )
        .bind(personId, row.email, row.name, row.name, nowMs),
    });
  }
  return plans;
}

/** Their standing on the talk: beside the submitter, never instead of them. */
export function coParticipation(
  db: D1Database,
  submissionId: string,
  personId: string,
  position: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO participation (submission_id, person_id, role, position, is_submitter)
       VALUES (?,?,'co_speaker',?,0)`
    )
    .bind(submissionId, personId, position);
}

/** Somebody on a talk. The role stays an enum here; the word for it is the
 *  label map's, at render time. */
export type OnTheTalk = {
  submissionId: string;
  personId: string;
  name: string;
  email: string | null;
  role: 'speaker' | 'co_speaker' | 'moderator';
  position: number;
  isSubmitter: boolean;
};

type ParticipationRow = {
  submission_id: string;
  person_id: string;
  name: string;
  email: string | null;
  role: 'speaker' | 'co_speaker' | 'moderator';
  position: number;
  is_submitter: number;
};

/** Who is on these talks, submitter first and then in the order they were
 *  added. One statement for a whole portal's worth of cards. */
export async function peopleOnTalks(
  db: D1Database,
  submissionIds: readonly string[]
): Promise<Map<string, OnTheTalk[]>> {
  const out = new Map<string, OnTheTalk[]>();
  if (!submissionIds.length) return out;
  const holes = submissionIds.map(() => '?').join(',');
  const res = await db
    .prepare(
      `SELECT pa.submission_id, pa.person_id, pa.role, pa.position, pa.is_submitter,
              pe.name, pe.email
         FROM participation pa
         JOIN person pe ON pe.id = pa.person_id
        WHERE pa.submission_id IN (${holes})
        ORDER BY pa.is_submitter DESC, pa.position, pe.name`
    )
    .bind(...submissionIds)
    .all<ParticipationRow>();
  for (const r of res.results) {
    const list = out.get(r.submission_id) ?? [];
    list.push({
      submissionId: r.submission_id,
      personId: r.person_id,
      name: r.name,
      email: r.email,
      role: r.role,
      position: r.position,
      isSubmitter: r.is_submitter === 1,
    });
    out.set(r.submission_id, list);
  }
  return out;
}

/** Who is on one talk. */
export async function peopleOnTalk(db: D1Database, submissionId: string): Promise<OnTheTalk[]> {
  return (await peopleOnTalks(db, [submissionId])).get(submissionId) ?? [];
}

/**
 * R-10 visibility, evaluated once and used three times: to decide which
 * answers are kept, which required questions are enforced, and which fields
 * the form counts. Questions are walked in the order the organizer set them,
 * so a question hanging off another hidden question stays hidden too.
 *
 * The controlling id may name one of the built-in fields (`format`, `track`,
 * `level`) as well as another question — the seeded call does exactly that.
 */
export function visibleQuestions(
  questions: readonly CfpQuestion[],
  builtIns: Record<string, string>,
  answers: Record<string, string | boolean>
): CfpQuestion[] {
  const shown = new Map<string, boolean>();
  const out: CfpQuestion[] = [];
  const valueOf = (id: string): string => {
    const builtIn = builtIns[id];
    if (builtIn !== undefined) return builtIn;
    if (shown.get(id) === false) return '';
    const a = answers[id];
    if (a === undefined) return '';
    return typeof a === 'boolean' ? String(a) : a;
  };
  for (const q of questions) {
    const on = q.showIf === null || valueOf(q.showIf.questionId) === q.showIf.equals;
    shown.set(q.id, on);
    if (on) out.push(q);
  }
  return out;
}

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

type EventRow = {
  name: string;
  max_submissions: number;
  cfp_opens_at: number | null;
  cfp_closes_at: number | null;
  decide_by: string | null;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

/** "20 August" — a calendar day is a date, not an instant, so no zone applies.
 *  Same rendering the portal gives the same fact, so the letter and the screen
 *  it lands on say the day the same way. */
function isoLong(iso: string): string {
  const m = Number(iso.slice(5, 7));
  return `${Number(iso.slice(8, 10))} ${MONTHS[m - 1] ?? ''}`.trim();
}

/**
 * The receipt. It is delivered the moment it is written — this is the one
 * message in the product that never sits in the outbox, because nobody decides
 * whether a proposal arrived. It is the answer to "did that go through", and it
 * is waiting in their portal before they think to ask.
 */
function receipt(title: string, eventName: string, decideBy: string | null): { subject: string; body: string } {
  const when = decideBy
    ? `Decisions go out by ${isoLong(decideBy)}.`
    : 'We will write the moment there is news.';
  return {
    subject: 'Your proposal is in',
    body: `“${title}” is with the committee at ${eventName}. ${when} Your portal has the latest, and the way back into your words is there too.`,
  };
}

/**
 * Send one proposal.
 *
 * Refusals come back as sentences with the control to return to; they are not
 * exceptions, because being told "you already have three in" is a normal thing
 * for this screen to say, not a failure of it.
 */
export async function submitProposal(
  db: D1Database,
  eventId: string,
  input: ProposalInput,
  nowMs: number = Date.now()
): Promise<SubmitOutcome> {
  const title = norm(input.title);
  const abstract = norm(input.abstract);
  const name = norm(input.name);
  const email = lower(input.email);
  const organisation = norm(input.organisation);

  if (!title) {
    return { ok: false, field: 'f-title', message: 'A title is needed — it is the line the committee reads first.' };
  }
  if (!abstract) {
    return {
      ok: false,
      field: 'f-abs',
      message: 'A paragraph about the talk is needed. Two or three sentences are plenty to start with.',
    };
  }
  if (abstract.length > ABSTRACT_MAX) {
    return {
      ok: false,
      field: 'f-abs',
      message: `The paragraph runs to ${abstract.length.toLocaleString('en-US')} characters and the program has room for ${ABSTRACT_MAX.toLocaleString('en-US')}. Cut the setup, keep the numbers.`,
    };
  }
  if (!name) {
    return { ok: false, field: 'f-name', message: 'A name is needed — it goes on the program.' };
  }
  if (!looksLikeAnAddress(email)) {
    return {
      ok: false,
      field: 'f-email',
      message: 'An email address is needed. The decision goes there, and so does the way back into your proposal.',
    };
  }

  const chosenFormat = FORMATS.find((f) => f.word === input.format);
  if (!chosenFormat) {
    return { ok: false, field: 'f-fmt', message: 'Choose a format so the grid knows how long to leave you.' };
  }
  const chosenLevel = LEVELS.find((l) => l.value === input.level);
  if (!chosenLevel) {
    return { ok: false, field: 'f-lvl', message: 'Say who the talk is for, so nobody walks into the wrong room.' };
  }

  const tracks = await tracksOfEvent(db, eventId);
  let trackId: string | null = null;
  if (tracks.length) {
    const chosen = tracks.find((t) => t.slug === input.trackSlug);
    if (!chosen) {
      return { ok: false, field: 'f-track', message: 'Pick the part of the program your talk belongs in.' };
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
      return { ok: false, field: `f-q-${q.id}`, message: `${q.label} is one the organizers ask everyone.` };
    }
  }

  // The people speaking with them. Their own address counts as taken, so a
  // speaker who types themselves into a row is simply already there.
  const coReading = readCoPresenters(input.co ?? [], [email]);
  if (!coReading.ok) {
    return { ok: false, field: coReading.field, message: coReading.message };
  }

  const ev = await db
    .prepare('SELECT name, max_submissions, cfp_opens_at, cfp_closes_at, decide_by FROM event WHERE id = ?')
    .bind(eventId)
    .first<EventRow>();
  if (!ev) return { ok: false, field: null, message: 'This call is not taking proposals.' };
  if (ev.cfp_closes_at === null || ev.cfp_closes_at <= nowMs) {
    return { ok: false, field: null, message: 'The call closed while this page was open, so nothing was sent.' };
  }
  if (ev.cfp_opens_at !== null && ev.cfp_opens_at > nowMs) {
    return { ok: false, field: null, message: 'This call has not opened yet.' };
  }

  const person = await findPersonByEmail(db, email);
  if (person) {
    const already = await countInFlight(db, eventId, person.id);
    if (already >= ev.max_submissions) {
      return {
        ok: false,
        field: null,
        message: `You already have ${already.toLocaleString('en-US')} ${already === 1 ? 'proposal' : 'proposals'} with this committee, which is as many as anyone may send. If this one should take the place of an earlier one, withdraw that from your speaker portal first.`,
      };
    }
  }

  const personId = person ? person.id : newId('per');
  const submissionId = newId('sub');
  // Read before the batch is built so a name already in the room keeps its own
  // person rather than gaining a second one.
  const co = await planCoPresenters(db, coReading.fresh, nowMs);
  const statements: D1PreparedStatement[] = [];
  const expect: number[] = [];

  // The call is still open — checked again, inside the batch, at write time.
  statements.push(
    guard(
      db,
      `SELECT 1 FROM event WHERE id = ?
         AND (cfp_closes_at IS NULL OR cfp_closes_at <= ?
              OR (cfp_opens_at IS NOT NULL AND cfp_opens_at > ?))`,
      eventId,
      nowMs,
      nowMs
    )
  );
  expect.push(0);

  if (person) {
    // The cap, re-read at write time so two tabs cannot both be the last one.
    statements.push(
      guard(
        db,
        `SELECT 1 FROM event e WHERE e.id = ?
           AND (SELECT COUNT(*) FROM submission s
                  JOIN participation pa ON pa.submission_id = s.id
                 WHERE s.event_id = e.id AND pa.person_id = ?
                   AND s.state NOT IN ('withdrawn','draft')) >= e.max_submissions`,
        eventId,
        person.id
      )
    );
    expect.push(0);
  } else {
    // A person, not an account: no password, no session, nothing to sign in with
    // until they ask for a link at the address they gave.
    statements.push(
      db
        .prepare(
          `INSERT INTO person (id, email, name, sort_name, organisation, share_contact, created_at)
           VALUES (?,?,?,?,?,'{}',?)`
        )
        .bind(personId, email, name, name, organisation || null, nowMs)
    );
    expect.push(1);
  }

  // Everyone else on the talk who is not yet anybody here. Written before the
  // rows that point at them, so nothing in the batch waits on a person.
  for (const mate of co) {
    if (!mate.create) continue;
    statements.push(mate.create);
    expect.push(1);
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO submission
           (id, event_id, title, abstract, format, track_id, level, requested_min,
            extra, source, created_at, submitted_at, state)
         VALUES (?,?,?,?,?,?,?,?,?,'cfp',?,?,'submitted')`
      )
      .bind(
        submissionId,
        eventId,
        title,
        abstract,
        chosenFormat.word,
        trackId,
        chosenLevel.value,
        chosenFormat.minutes,
        JSON.stringify(kept),
        nowMs,
        nowMs
      )
  );
  expect.push(1);

  statements.push(
    db
      .prepare(
        `INSERT INTO participation (submission_id, person_id, role, position, is_submitter)
         VALUES (?,?,'speaker',0,1)`
      )
      .bind(submissionId, personId)
  );
  expect.push(1);

  // Beside them, in the order they were typed. Position 0 is the submitter's,
  // and nothing here can take it.
  co.forEach((mate, i) => {
    statements.push(coParticipation(db, submissionId, mate.personId, i + 1));
    expect.push(1);
  });

  // CFP-08: the receipt, written and delivered in the same breath as the
  // proposal it is about. delivered_at is set here and nowhere else in the
  // product's writing path — a decision is told in a second act, but an arrival
  // is not something anybody has to decide to tell you.
  const note = receipt(title, ev.name, ev.decide_by);
  statements.push(
    db
      .prepare(
        `INSERT INTO message
           (id, event_id, person_id, submission_id, kind, subject, body, created_at, delivered_at)
         VALUES (?,?,?,?,'received',?,?,?,?)`
      )
      .bind(newId('msg'), eventId, personId, submissionId, note.subject, note.body, nowMs, nowMs)
  );
  expect.push(1);

  try {
    await checkedBatch(db, statements, expect, 'the call closed while you were writing');
  } catch (e) {
    if (e instanceof StaleStateError) {
      return {
        ok: false,
        field: null,
        message:
          'Nothing was sent: either the call closed while this page was open, or you now have as many proposals in as anyone may send. Your words are still here.',
      };
    }
    return {
      ok: false,
      field: null,
      message: 'Nothing was sent, and nothing was lost. Press send again — your words are still here.',
    };
  }

  return { ok: true, submissionId, personId, email };
}

/**
 * The parts of the program a speaker can aim at.
 *
 * This lives with the writer rather than in queries/public.ts because the same
 * three rows do both jobs — they are the radio buttons on the form and the
 * track_id resolved on the way in — and a form that offered a choice the writer
 * could not honour would be the bug. See the report: a `tracks()` reader in
 * queries/public.ts is the tidier long-term home.
 */
export async function tracksOfEvent(db: D1Database, eventId: string): Promise<TrackOption[]> {
  const res = await db
    .prepare('SELECT id, slug, name, colour FROM track WHERE event_id = ? ORDER BY position, name')
    .bind(eventId)
    .all<TrackOption>();
  return res.results;
}

/** How many proposals this person has with this committee that still count. */
async function countInFlight(db: D1Database, eventId: string, personId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM submission s
         JOIN participation pa ON pa.submission_id = s.id
        WHERE s.event_id = ? AND pa.person_id = ?
          AND s.state NOT IN ('withdrawn','draft')`
    )
    .bind(eventId, personId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
