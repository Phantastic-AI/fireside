// The event's own controls, written down. Everything here is a guarded batch:
// the guard is the precondition the human was looking at when they pressed the
// button, so a save that arrives after somebody else's save refuses instead of
// quietly winning.
//
// Every function returns a code from one closed set. The screen owns the
// sentences; this file owns the facts and never writes prose.
//
// Three rules this file exists to keep:
//   1. Changing the call's questions never touches an answer already given.
//      Answers live in submission.extra keyed by question id, and a question's
//      id is carried through every edit — rename the words all you like.
//   2. A conference cannot be left with nobody who owns it. The last owner
//      cannot be demoted or removed, and the refusal is checked in the batch,
//      not only on the screen.
//   3. Changing the round's scorecard never orphans a mark already given.
//      Marks live in review.scores keyed by the line's own key, the key is
//      carried through every edit, and a line only comes off the card while
//      the round is still silent.

import { checkedBatch, guard, newId, now } from '../lib/db';
import { requireScope, EDIT_ROLES } from '../queries/admin';
import { isEventRole, TEAM_ROLES, type EventRole } from '../queries/settings';
import {
  CRITERION_KEY,
  MOST_CHOICES,
  MOST_CRITERIA,
  SCORED_SQL,
  type ScorecardKind,
  type ScorecardWeight,
} from '../queries/reviews';
import type { Principal } from './account';
import { findPersonByEmail } from './account';

/** The closed set. The screen renders exactly one of these as a sentence. */
export type Said =
  | 'event_saved'
  | 'event_name_needed'
  | 'event_cap'
  | 'event_date'
  | 'event_opens_date'
  | 'event_closes_date'
  | 'event_closes_first'
  | 'event_moved'
  | 'questions_saved'
  | 'questions_words_needed'
  | 'questions_kind'
  | 'questions_choices_needed'
  | 'questions_show_if'
  | 'questions_moved'
  | 'scorecard_saved'
  | 'scorecard_words_needed'
  | 'scorecard_kind'
  | 'scorecard_choices_needed'
  | 'scorecard_weight'
  | 'scorecard_last'
  | 'scorecard_too_many'
  | 'scorecard_scored'
  | 'scorecard_moved'
  | 'team_added'
  | 'team_invited'
  | 'team_role_changed'
  | 'team_removed'
  | 'team_email_needed'
  | 'team_already'
  | 'team_gone'
  | 'team_last_owner'
  | 'team_standing_unknown'
  | 'team_moved'
  | 'link_made'
  | 'link_rotated'
  | 'link_moved'
  | 'room_added'
  | 'room_name_needed'
  | 'room_name_taken'
  | 'room_renamed'
  | 'room_moved'
  | 'room_gone'
  | 'track_added'
  | 'track_name_needed'
  | 'track_renamed'
  | 'track_moved'
  | 'track_gone'
  | 'nothing_sent';

const stale = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'StaleStateError' || e.name === 'ChangesMismatchError');

const trimmed = (s: string): string => s.trim();
const orNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());

/* ------------------------------------------------------------------ *
 * 1 — the event itself
 * ------------------------------------------------------------------ */

export type EventFacts = {
  name: string;
  tagline: string;
  venueName: string;
  venueAddress: string;
  cfpIntro: string;
  decideBy: string;
  maxSubmissions: string;
  /** The call window, as days. Opens at the start of its day, closes at the
   *  end of its own (UTC — the same within-a-day convention creation uses).
   *  Both blank = the call is shut. */
  callOpensOn: string;
  callClosesOn: string;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A day the calendar actually has. The shape check passes 2026-13-45, and
 *  Date.parse quietly rolls 2025-02-30 forward into March — neither is the day
 *  somebody typed, so neither is a day this page saves. */
function isDay(day: string): boolean {
  if (!ISO_DAY.test(day)) return false;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/**
 * Dates and time zone are deliberately not here: moving them after proposals
 * are in moves every session already placed on the agenda, and that is a
 * different act than editing a line of copy.
 */
export async function saveEventFacts(
  db: D1Database,
  principal: Principal,
  eventId: string,
  facts: EventFacts
): Promise<Said> {
  requireScope(principal, eventId, EDIT_ROLES);

  const name = trimmed(facts.name);
  if (name === '') return 'event_name_needed';

  const cap = Number(trimmed(facts.maxSubmissions));
  if (!Number.isInteger(cap) || cap < 1 || cap > 10) return 'event_cap';

  const decideBy = trimmed(facts.decideBy);
  if (decideBy !== '' && !isDay(decideBy)) return 'event_date';

  // Each date refuses in its own name, because the screen puts the sentence
  // beside the input it is about and a shared code cannot say which one moved.
  const opensOn = trimmed(facts.callOpensOn);
  const closesOn = trimmed(facts.callClosesOn);
  if (opensOn !== '' && !isDay(opensOn)) return 'event_opens_date';
  if (closesOn !== '' && !isDay(closesOn)) return 'event_closes_date';
  if (closesOn !== '' && opensOn !== '' && closesOn < opensOn) return 'event_closes_first';
  const opensAt = opensOn === '' ? null : Date.parse(`${opensOn}T00:00:00Z`);
  const closesAt = closesOn === '' ? null : Date.parse(`${closesOn}T23:59:59Z`);

  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM event WHERE id = ?1)', eventId),
        db
          .prepare(
            `UPDATE event SET name = ?2, tagline = ?3, venue_name = ?4, venue_address = ?5,
                    cfp_intro = ?6, decide_by = ?7, max_submissions = ?8,
                    cfp_opens_at = ?9, cfp_closes_at = ?10
             WHERE id = ?1`
          )
          .bind(
            eventId,
            name,
            orNull(facts.tagline),
            orNull(facts.venueName),
            orNull(facts.venueAddress),
            orNull(facts.cfpIntro),
            decideBy === '' ? null : decideBy,
            cap,
            opensAt,
            closesAt
          ),
      ],
      [0, 1]
    );
  } catch (e) {
    if (stale(e)) return 'event_moved';
    throw e;
  }
  return 'event_saved';
}

/* ------------------------------------------------------------------ *
 * 2 — the call's questions (R-10)
 * ------------------------------------------------------------------ */

export type QuestionDraft = {
  /** Empty for a question being added; otherwise the id answers are keyed by. */
  id: string;
  label: string;
  hint: string;
  kind: string;
  required: boolean;
  options: string[];
  /** The question this one hangs off, and the answer that brings it out. */
  when: string;
  is: string;
  /** Ticked means: take it off the call. Answers already given stay. */
  off: boolean;
};

type StoredQuestion = {
  id: string;
  kind: 'short' | 'long' | 'select' | 'checkbox';
  label: string;
  hint: string | null;
  required: boolean;
  options: string[] | null;
  showIf: { questionId: string; equals: string } | null;
  position: number;
};

const KINDS = ['short', 'long', 'select', 'checkbox'] as const;

function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/**
 * Validate the whole set and write it in one guarded update. `seen` is the
 * stored text the screen was showing: if it moved, nothing is written and the
 * page comes back with what is actually on the call.
 */
export async function saveQuestions(
  db: D1Database,
  principal: Principal,
  eventId: string,
  seen: string,
  drafts: QuestionDraft[]
): Promise<Said> {
  requireScope(principal, eventId, EDIT_ROLES);

  // A question with no words is a question nobody can answer. Blanking one is
  // never how a question comes off the call — that is the tick that says so,
  // and it refuses here rather than deleting something quietly.
  const kept: QuestionDraft[] = [];
  for (const d of drafts) {
    if (d.off) continue;
    if (trimmed(d.label) !== '') {
      kept.push(d);
      continue;
    }
    if (trimmed(d.id) !== '') return 'questions_words_needed';
    const started =
      trimmed(d.hint) !== '' ||
      trimmed(d.when) !== '' ||
      trimmed(d.is) !== '' ||
      d.required ||
      d.options.some((o) => trimmed(o) !== '');
    if (started) return 'questions_words_needed';
    // an untouched blank row: nothing was being added
  }

  const taken = new Set<string>();
  const built: StoredQuestion[] = [];

  for (const d of kept) {
    if (!(KINDS as readonly string[]).includes(d.kind)) return 'questions_kind';
    const kind = d.kind as StoredQuestion['kind'];

    const options = d.options.map(trimmed).filter((o) => o !== '');
    if (kind === 'select' && options.length < 2) return 'questions_choices_needed';

    let id = trimmed(d.id);
    if (id === '' || taken.has(id)) {
      const wanted = slugOf(d.label);
      id = wanted !== '' && !taken.has(wanted) ? wanted : newId('q');
    }
    taken.add(id);

    // A question can only hang off one asked before it — the form is walked in
    // order, so a condition pointing forward would never come true.
    let showIf: StoredQuestion['showIf'] = null;
    const when = trimmed(d.when);
    if (when !== '') {
      const parent = built.find((q) => q.id === when);
      const answer = trimmed(d.is);
      if (!parent || answer === '') return 'questions_show_if';
      showIf = { questionId: parent.id, equals: answer };
    }

    built.push({
      id,
      kind,
      label: trimmed(d.label),
      hint: orNull(d.hint),
      required: d.required,
      options: kind === 'select' ? options : null,
      showIf,
      position: built.length + 1,
    });
  }

  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 FROM event WHERE id = ?1 AND questions <> ?2', eventId, seen),
        db
          .prepare('UPDATE event SET questions = ?2 WHERE id = ?1')
          .bind(eventId, JSON.stringify(built)),
      ],
      [0, 1]
    );
  } catch (e) {
    if (stale(e)) return 'questions_moved';
    throw e;
  }
  return 'questions_saved';
}

/* ------------------------------------------------------------------ *
 * 2b — the round's scorecard (R-11)
 * ------------------------------------------------------------------ */

export type CriterionDraft = {
  /** Empty for a line being added; otherwise the key marks are stored under. */
  key: string;
  label: string;
  kind: string;
  options: string[];
  weight: string;
};

type StoredCriterion = {
  key: string;
  label: string;
  kind: ScorecardKind;
  weight: ScorecardWeight;
  max?: number;
  options?: string[];
};

const CRITERION_KINDS: readonly ScorecardKind[] = ['scale', 'select', 'text'];

/**
 * Write one round's scorecard.
 *
 * The same shape as saveQuestions one section up, and for the same two
 * reasons: the whole set is validated and written together so a half-saved
 * card cannot exist, and `seen` is the stored text the screen was showing, so
 * a save arriving after somebody else's save refuses rather than quietly
 * winning. Moving a line is a submit on the same form, so a move carries every
 * pending edit with it.
 *
 * A KEY IS NEVER REWRITTEN. Marks are stored under it, exactly as answers are
 * stored under a question's id — rename the words all you like and every mark
 * already given still means what it meant.
 *
 * TAKING A LINE OFF IS THE ONE ACT THAT CAN BE REFUSED. Once a review has been
 * sent in this round, that review holds a mark under the key, and dropping the
 * key would leave the mark on the record with nothing to say what it was for.
 * So removal is allowed only while the round is still silent, checked here for
 * the sentence and guarded in the batch so a review arriving mid-click takes
 * the whole thing down. A reviewer who stepped aside holds no marks and does
 * not stand in the way.
 *
 * A WEIGHT CHANGED AFTER MARKS ARE IN CHANGES EVERY AVERAGE DRAWN FROM THEM.
 * That is not refused — a committee is allowed to decide that depth counts
 * double halfway through — but the screen says it out loud beforehand.
 */
export async function saveScorecard(
  db: D1Database,
  principal: Principal,
  eventId: string,
  round: number,
  seen: string,
  drafts: CriterionDraft[],
  /** The key the chair asked to take off, if she asked for one. */
  removing: string
): Promise<Said> {
  requireScope(principal, eventId, EDIT_ROLES);
  if (!Number.isInteger(round) || round < 1) return 'scorecard_moved';

  const off = trimmed(removing);
  const taken = new Set<string>();
  const built: StoredCriterion[] = [];

  for (const d of drafts) {
    const held = trimmed(d.key);
    if (off !== '' && held !== '' && held === off) continue;

    const words = trimmed(d.label);
    if (words === '') {
      // Blanking a line is never how one comes off — that is the button that
      // says so. An untouched blank row at the end is nobody adding anything.
      if (held !== '') return 'scorecard_words_needed';
      const started =
        trimmed(d.kind) !== 'scale' || d.options.some((o) => trimmed(o) !== '');
      if (started) return 'scorecard_words_needed';
      continue;
    }

    if (!(CRITERION_KINDS as readonly string[]).includes(d.kind)) return 'scorecard_kind';
    const kind = d.kind as ScorecardKind;

    const options = d.options.map(trimmed).filter((o) => o !== '').slice(0, MOST_CHOICES);
    if (kind === 'select' && options.length < 2) return 'scorecard_choices_needed';

    const weightNumber = Number(trimmed(d.weight));
    if (weightNumber !== 1 && weightNumber !== 2 && weightNumber !== 3) return 'scorecard_weight';
    const weight = weightNumber as ScorecardWeight;

    let key = CRITERION_KEY.test(held) ? held : '';
    if (key === '' || taken.has(key)) {
      const wanted = slugOf(words);
      key = CRITERION_KEY.test(wanted) && !taken.has(wanted) ? wanted : newId('sc');
    }
    taken.add(key);

    built.push({
      key,
      label: words,
      kind,
      weight,
      ...(kind === 'scale' ? { max: 5 } : {}),
      ...(kind === 'select' ? { options } : {}),
    });
  }

  // A round with no lines on its card puts every reviewer in front of the
  // fallback single mark, which is a scorecard nobody chose. Emptying it is
  // not an act this page offers.
  if (built.length === 0) return 'scorecard_last';
  if (built.length > MOST_CRITERIA) return 'scorecard_too_many';

  if (off !== '') {
    const heard = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM review rv
           JOIN submission s ON s.id = rv.submission_id
          WHERE s.event_id = ?1 AND rv.round = ?2 AND ${SCORED_SQL}`
      )
      .bind(eventId, round)
      .first<{ n: number }>();
    if ((heard?.n ?? 0) > 0) return 'scorecard_scored';
  }

  let stored: unknown;
  try {
    stored = JSON.parse(seen);
  } catch {
    stored = {};
  }
  const cards: Record<string, unknown> =
    typeof stored === 'object' && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  cards[String(round)] = built;

  const statements = [
    guard(db, 'SELECT 1 FROM event WHERE id = ?1 AND round_scorecards <> ?2', eventId, seen),
    // The round the screen was editing is the round that gets written. If the
    // committee opened the next one while this page was open, the edit belongs
    // to a round nobody is reading any more, and it refuses.
    guard(db, 'SELECT 1 FROM event WHERE id = ?1 AND current_round <> ?2', eventId, round),
    ...(off !== ''
      ? [
          guard(
            db,
            `SELECT 1 FROM review rv
               JOIN submission s ON s.id = rv.submission_id
              WHERE s.event_id = ?1 AND rv.round = ?2 AND ${SCORED_SQL}`,
            eventId,
            round
          ),
        ]
      : []),
    db
      .prepare('UPDATE event SET round_scorecards = ?2 WHERE id = ?1')
      .bind(eventId, JSON.stringify(cards)),
  ];

  try {
    await checkedBatch(db, statements, [...statements.slice(0, -1).map(() => 0), 1]);
  } catch (e) {
    if (stale(e)) return 'scorecard_moved';
    throw e;
  }
  return 'scorecard_saved';
}

/* ------------------------------------------------------------------ *
 * 3 — the team (D-026)
 * ------------------------------------------------------------------ */

type StandingRow = { role: EventRole };
type CountRow = { n: number };

async function ownerCount(db: D1Database, eventId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM event_role WHERE event_id = ? AND role = 'owner'")
    .bind(eventId)
    .first<CountRow>();
  return row?.n ?? 0;
}

async function standingOf(
  db: D1Database,
  eventId: string,
  personId: string
): Promise<EventRole | null> {
  const row = await db
    .prepare('SELECT role FROM event_role WHERE event_id = ? AND person_id = ?')
    .bind(eventId, personId)
    .first<StandingRow>();
  return row?.role ?? null;
}

/** The guard behind every last-owner refusal: one expression, both writers. */
const LAST_OWNER_SQL = `SELECT 1 WHERE ?3 <> 'owner'
  AND EXISTS (SELECT 1 FROM event_role WHERE event_id = ?1 AND person_id = ?2 AND role = 'owner')
  AND (SELECT COUNT(*) FROM event_role WHERE event_id = ?1 AND role = 'owner') < 2`;

/** What an add did. `invited` is set only when the add made the account, since
 *  somebody who has never signed in has no way in until they are handed one. */
export type TeamAdd = {
  said: Said;
  invited: { personId: string; email: string; name: string } | null;
};

/** A name from the address, for the person who did not type one. A name goes
 *  on programs, so it is never left blank — and it is theirs to correct the
 *  first time they sign in. */
function nameFromEmail(address: string): string {
  const at = address.indexOf('@');
  const words = address
    .slice(0, at > 0 ? at : address.length)
    .split(/[._+-]+/)
    .filter((w) => w !== '')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(' ') || address;
}

/** An address somebody could actually sign in with — one @, something either side. */
const ADDRESS = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

/**
 * Put somebody on the conference. If nobody signs in with that address yet,
 * the account and the standing are made together in one batch, so a half-added
 * person — a row with no standing, or a standing pointing at nobody — cannot
 * exist. The guard is the address itself: two owners typing the same one at
 * the same moment produce one account, not two.
 */
export async function addToTeam(
  db: D1Database,
  principal: Principal,
  eventId: string,
  email: string,
  name: string,
  role: string
): Promise<TeamAdd> {
  requireScope(principal, eventId, TEAM_ROLES);

  const address = trimmed(email).toLowerCase();
  if (address === '') return { said: 'team_email_needed', invited: null };
  if (!ADDRESS.test(address)) return { said: 'team_email_needed', invited: null };
  if (!isEventRole(role)) return { said: 'team_standing_unknown', invited: null };

  const person = await findPersonByEmail(db, address);

  if (person) {
    if ((await standingOf(db, eventId, person.id)) !== null) {
      return { said: 'team_already', invited: null };
    }
    try {
      await checkedBatch(
        db,
        [
          guard(db, 'SELECT 1 FROM event_role WHERE event_id = ?1 AND person_id = ?2', eventId, person.id),
          db
            .prepare(
              'INSERT INTO event_role (person_id, event_id, role, granted_at, granted_by) VALUES (?1,?2,?3,?4,?5)'
            )
            .bind(person.id, eventId, role, now(), principal.personId),
        ],
        [0, 1]
      );
    } catch (e) {
      if (stale(e)) return { said: 'team_already', invited: null };
      throw e;
    }
    return { said: 'team_added', invited: null };
  }

  const called = trimmed(name).slice(0, 120) || nameFromEmail(address);
  const personId = newId('per');
  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 FROM person WHERE email = ?1', address),
        db
          .prepare(
            'INSERT INTO person (id, email, name, sort_name, share_contact, created_at) VALUES (?1,?2,?3,?3,?4,?5)'
          )
          .bind(personId, address, called, '{}', now()),
        db
          .prepare(
            'INSERT INTO event_role (person_id, event_id, role, granted_at, granted_by) VALUES (?1,?2,?3,?4,?5)'
          )
          .bind(personId, eventId, role, now(), principal.personId),
      ],
      [0, 1, 1]
    );
  } catch (e) {
    if (stale(e)) return { said: 'team_already', invited: null };
    throw e;
  }
  return { said: 'team_invited', invited: { personId, email: address, name: called } };
}

export async function changeStanding(
  db: D1Database,
  principal: Principal,
  eventId: string,
  personId: string,
  role: string
): Promise<Said> {
  requireScope(principal, eventId, TEAM_ROLES);

  if (personId === '') return 'nothing_sent';
  if (!isEventRole(role)) return 'team_standing_unknown';

  const held = await standingOf(db, eventId, personId);
  if (held === null) return 'team_gone';
  if (held === role) return 'team_role_changed'; // same standing twice is one change
  if (held === 'owner' && role !== 'owner' && (await ownerCount(db, eventId)) < 2) {
    return 'team_last_owner';
  }

  try {
    await checkedBatch(
      db,
      [
        guard(
          db,
          'SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM event_role WHERE event_id = ?1 AND person_id = ?2)',
          eventId,
          personId
        ),
        guard(db, LAST_OWNER_SQL, eventId, personId, role),
        db
          .prepare('UPDATE event_role SET role = ?3 WHERE event_id = ?1 AND person_id = ?2')
          .bind(eventId, personId, role),
      ],
      [0, 0, 1]
    );
  } catch (e) {
    if (stale(e)) return 'team_moved';
    throw e;
  }
  return 'team_role_changed';
}

export async function takeOffTeam(
  db: D1Database,
  principal: Principal,
  eventId: string,
  personId: string
): Promise<Said> {
  requireScope(principal, eventId, TEAM_ROLES);

  if (personId === '') return 'nothing_sent';

  const held = await standingOf(db, eventId, personId);
  if (held === null) return 'team_gone';
  if (held === 'owner' && (await ownerCount(db, eventId)) < 2) return 'team_last_owner';

  try {
    await checkedBatch(
      db,
      [
        guard(
          db,
          'SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM event_role WHERE event_id = ?1 AND person_id = ?2)',
          eventId,
          personId
        ),
        // '' can never be a role, so the last-owner guard reads as "removing".
        guard(db, LAST_OWNER_SQL, eventId, personId, ''),
        db
          .prepare('DELETE FROM event_role WHERE event_id = ?1 AND person_id = ?2')
          .bind(eventId, personId),
      ],
      [0, 0, 1]
    );
  } catch (e) {
    if (stale(e)) return 'team_moved';
    throw e;
  }
  return 'team_removed';
}

/* ------------------------------------------------------------------ *
 * 4 — the rooms and the tracks (AIA-02)
 * ------------------------------------------------------------------ */

/** The track wheel a new event is painted with — TRACK_COLOURS in
 *  workflows/create-event.ts. Redeclared rather than imported: create-event.ts
 *  is not this parcel's to reach into, and a five-colour constant is cheap to
 *  keep in step by eye. If it ever drifts from the source, that source wins. */
const TRACK_COLOURS = ['#B14D14', '#2F5D50', '#8B3A62', '#3E5C76', '#7A5C2E'];

function trackSlugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * A room is added, never removed here: a room with sessions already placed
 * on it is part of the conference's own history (AIA-02). Position is
 * appended after whatever is already on the list.
 */
export async function addRoom(
  db: D1Database,
  principal: Principal,
  eventId: string,
  name: string
): Promise<Said> {
  requireScope(principal, eventId, EDIT_ROLES);

  const roomName = trimmed(name);
  if (roomName === '') return 'room_name_needed';

  const at = await db
    .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM room WHERE event_id = ?')
    .bind(eventId)
    .first<{ m: number }>();
  const position = (at?.m ?? -1) + 1;

  // room carries a UNIQUE(event_id, name) — the guard IS that constraint,
  // same idiom createEvent uses for its own slug: check the exact thing the
  // insert would collide on, not just that the event still exists.
  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 FROM room WHERE event_id = ?1 AND name = ?2', eventId, roomName),
        db
          .prepare('INSERT INTO room (id, event_id, name, position) VALUES (?,?,?,?)')
          .bind(newId('room'), eventId, roomName, position),
      ],
      [0, 1]
    );
  } catch (e) {
    if (stale(e)) return 'room_name_taken';
    throw e;
  }
  return 'room_added';
}

/** Renaming a room carries every session already placed on it — nothing
 *  keyed off the name has to move, because nothing is keyed off the name. */
export async function renameRoom(
  db: D1Database,
  principal: Principal,
  eventId: string,
  roomId: string,
  name: string
): Promise<Said> {
  requireScope(principal, eventId, EDIT_ROLES);

  const roomName = trimmed(name);
  if (roomName === '') return 'room_name_needed';

  // The UNIQUE(event_id, name) collision is the one this function's own
  // words can name precisely, so it is checked live rather than left for the
  // constraint to refuse blindly — the guard below stays existence-only.
  const clash = await db
    .prepare('SELECT 1 FROM room WHERE event_id = ? AND name = ? AND id <> ?')
    .bind(eventId, roomName, roomId)
    .first();
  if (clash) return 'room_name_taken';

  try {
    await checkedBatch(
      db,
      [
        guard(
          db,
          'SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM room WHERE id = ?1 AND event_id = ?2)',
          roomId,
          eventId
        ),
        db.prepare('UPDATE room SET name = ?3 WHERE id = ?1 AND event_id = ?2').bind(roomId, eventId, roomName),
      ],
      [0, 1]
    );
  } catch (e) {
    if (stale(e)) return 'room_gone';
    throw e;
  }
  return 'room_renamed';
}

/**
 * A track is added, never removed here — same reasoning as a room. Its
 * colour is the next one on the creation wheel, so a hand-added track reads
 * the same as one an event started with.
 */
export async function addTrack(
  db: D1Database,
  principal: Principal,
  eventId: string,
  name: string
): Promise<Said> {
  requireScope(principal, eventId, EDIT_ROLES);

  const trackName = trimmed(name);
  if (trackName === '') return 'track_name_needed';

  const at = await db
    .prepare('SELECT COALESCE(MAX(position), -1) AS m, COUNT(*) AS n FROM track WHERE event_id = ?')
    .bind(eventId)
    .first<{ m: number; n: number }>();
  const position = (at?.m ?? -1) + 1;
  const colour = TRACK_COLOURS[(at?.n ?? 0) % TRACK_COLOURS.length];

  // Same id-collision idiom saveQuestions uses below: prefer the readable
  // slug, fall back to a random one the instant two tracks would share it.
  const wanted = trackSlugOf(trackName);
  const taken =
    wanted !== ''
      ? await db.prepare('SELECT 1 FROM track WHERE event_id = ? AND slug = ?').bind(eventId, wanted).first()
      : true;
  const slug = wanted !== '' && !taken ? wanted : newId('trk');

  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM event WHERE id = ?1)', eventId),
        db
          .prepare('INSERT INTO track (id, event_id, name, slug, colour, position) VALUES (?,?,?,?,?,?)')
          .bind(newId('trk'), eventId, trackName, slug, colour, position),
      ],
      [0, 1]
    );
  } catch (e) {
    if (stale(e)) return 'track_moved';
    throw e;
  }
  return 'track_added';
}

/** Renaming a track carries every proposal already sorted onto it — the slug
 *  and the colour, both the join key and the paint, stay exactly put. */
export async function renameTrack(
  db: D1Database,
  principal: Principal,
  eventId: string,
  trackId: string,
  name: string
): Promise<Said> {
  requireScope(principal, eventId, EDIT_ROLES);

  const trackName = trimmed(name);
  if (trackName === '') return 'track_name_needed';

  try {
    await checkedBatch(
      db,
      [
        guard(
          db,
          'SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM track WHERE id = ?1 AND event_id = ?2)',
          trackId,
          eventId
        ),
        db
          .prepare('UPDATE track SET name = ?3 WHERE id = ?1 AND event_id = ?2')
          .bind(trackId, eventId, trackName),
      ],
      [0, 1]
    );
  } catch (e) {
    if (stale(e)) return 'track_gone';
    throw e;
  }
  return 'track_renamed';
}

/* ------------------------------------------------------------------ *
 * 5 — the green room link (R-4)
 * ------------------------------------------------------------------ */

/**
 * A fresh nonce. `seen` is the link the human was looking at — if it had
 * already changed, nothing is rotated and they are shown the one that works,
 * because rotating twice would strand a crew that just got the new one.
 */
export async function newGreenRoomLink(
  db: D1Database,
  principal: Principal,
  eventId: string,
  seen: string
): Promise<Said> {
  requireScope(principal, eventId, EDIT_ROLES);

  const held = seen.trim() === '' ? null : seen.trim();
  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 FROM event WHERE id = ?1 AND green_room_nonce IS NOT ?2', eventId, held),
        db
          .prepare('UPDATE event SET green_room_nonce = ?2 WHERE id = ?1')
          .bind(eventId, newId('grn')),
      ],
      [0, 1]
    );
  } catch (e) {
    if (stale(e)) return 'link_moved';
    throw e;
  }
  return held === null ? 'link_made' : 'link_rotated';
}
