// The event's own controls, written down. Everything here is a guarded batch:
// the guard is the precondition the human was looking at when they pressed the
// button, so a save that arrives after somebody else's save refuses instead of
// quietly winning.
//
// Every function returns a code from one closed set. The screen owns the
// sentences; this file owns the facts and never writes prose.
//
// Two rules this file exists to keep:
//   1. Changing the call's questions never touches an answer already given.
//      Answers live in submission.extra keyed by question id, and a question's
//      id is carried through every edit — rename the words all you like.
//   2. A conference cannot be left with nobody who owns it. The last owner
//      cannot be demoted or removed, and the refusal is checked in the batch,
//      not only on the screen.

import { checkedBatch, guard, newId, now } from '../lib/db';
import { requireScope, EDIT_ROLES } from '../queries/admin';
import { isEventRole, TEAM_ROLES, type EventRole } from '../queries/settings';
import type { Principal } from './account';
import { findPersonByEmail } from './account';

/** The closed set. The screen renders exactly one of these as a sentence. */
export type Said =
  | 'event_saved'
  | 'event_name_needed'
  | 'event_cap'
  | 'event_date'
  | 'event_moved'
  | 'questions_saved'
  | 'questions_words_needed'
  | 'questions_kind'
  | 'questions_choices_needed'
  | 'questions_show_if'
  | 'questions_moved'
  | 'team_added'
  | 'team_role_changed'
  | 'team_removed'
  | 'team_email_needed'
  | 'team_no_person'
  | 'team_already'
  | 'team_gone'
  | 'team_last_owner'
  | 'team_standing_unknown'
  | 'team_moved'
  | 'link_made'
  | 'link_rotated'
  | 'link_moved'
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
  if (decideBy !== '' && !ISO_DAY.test(decideBy)) return 'event_date';

  const opensOn = trimmed(facts.callOpensOn);
  const closesOn = trimmed(facts.callClosesOn);
  if (opensOn !== '' && !ISO_DAY.test(opensOn)) return 'event_date';
  if (closesOn !== '' && !ISO_DAY.test(closesOn)) return 'event_date';
  if (closesOn !== '' && opensOn !== '' && closesOn < opensOn) return 'event_date';
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

export async function addToTeam(
  db: D1Database,
  principal: Principal,
  eventId: string,
  email: string,
  role: string
): Promise<Said> {
  requireScope(principal, eventId, TEAM_ROLES);

  const address = trimmed(email);
  if (address === '') return 'team_email_needed';
  if (!isEventRole(role)) return 'team_standing_unknown';

  const person = await findPersonByEmail(db, address);
  if (!person) return 'team_no_person';
  if ((await standingOf(db, eventId, person.id)) !== null) return 'team_already';

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
    if (stale(e)) return 'team_already';
    throw e;
  }
  return 'team_added';
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
 * 4 — the green room link (R-4)
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
