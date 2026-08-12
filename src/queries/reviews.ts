// The reviewer's read layer (R-11) — round-scoped, and blind by construction.
//
// BLIND IS A PROPERTY OF THIS FILE, not of the template that renders it. No
// statement below joins `participation` or `person`, and none selects a name,
// an employer, an address or a headshot. A screen built on this query cannot
// show a reviewer who wrote a proposal, because the fact never reaches it.
// That is the same discipline queries/admin.ts applies to scope: the read is
// the chokepoint, and a template's good intentions are not a security model.
//
// GAP, flagged rather than invented: the schema has no per-event blind toggle,
// so blind is unconditional here. An event that wants names visible during
// round 2 has no way to say so. The fix is a column on `event` plus a settings
// control, both of which belong to the settings parcel — not to a route file
// quietly selecting names when a query string asks it to.
//
// ASSIGNMENT IS ALSO A PROPERTY OF THIS FILE. "Which of these are mine?" used
// to answer "every proposal still undecided on this event", which is the same
// leak in a friendlier coat: a committee of six all reading the whole pile is
// a portal that shows every proposal to every reviewer. An assignment is a
// review row created empty — scores '{}', submitted_at NULL — for one
// (submission, reviewer, round). The reviewer's queue is now the set of
// proposals that have such a row for HER, and a reviewer with no rows sees an
// empty evening rather than everybody else's work.
//
// The one exception is deliberate and labelled on the screen: whoever may
// decide on this event (install-wide organizers, owners, approvers) keeps the
// everything view, because the chair reads the pile to hand it out. That is
// the same standing workflows/decide.ts gates on, read through `everything`
// below rather than restated here.
//
// Scope is READ_ROLES: viewers review. Lena Fischer holds 'viewer' on AI
// Engineer New York and this is the one backstage screen that is hers.

import type { Principal } from '../workflows/account';
import { requireScope, READ_ROLES } from './admin';
import { requireDecider } from '../workflows/decide';

/* ------------------------------------------------------------------ *
 * The canonical expressions
 * ------------------------------------------------------------------ */

/**
 * THE ONE EXPRESSION for "staged, mine, not yet submitted" — the D-024 half
 * of a review's life. A row with no scores in it is not staged: it is a row
 * somebody opened and left, and counting it would put a number on the masthead
 * that means nothing. Every count, every cohort and every guard in the review
 * path derives from this string, so the number a person confirms and the number
 * that goes cannot differ by one (the law release.ts holds for letters).
 *
 * Requires the review to be aliased `rv`.
 */
export const MY_STAGED_SQL =
  "rv.submitted_at IS NULL AND EXISTS (SELECT 1 FROM json_each(rv.scores))";

/**
 * THE ONE EXPRESSION for "assigned and untouched" — a review row somebody was
 * given and has not written in. It is the exact complement of MY_STAGED_SQL
 * inside submitted_at IS NULL, which is what makes taking an assignment back
 * safe to offer: a row that matches this holds no one's work, and a row that
 * does not match holds somebody's evening. The organizer's take-back reads
 * from this string and so does the count on the button, so the number she is
 * offered and the number that goes cannot differ.
 *
 * Requires the review to be aliased `rv`.
 */
export const UNTOUCHED_SQL =
  "rv.submitted_at IS NULL AND NOT EXISTS (SELECT 1 FROM json_each(rv.scores))";

/** Whoever may decide may also hand the pile out, and reads all of it to do so. */
export function seesEverything(principal: Principal, eventId: string): boolean {
  try {
    requireDecider(principal, eventId);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * DTOs
 * ------------------------------------------------------------------ */

/** One line of the round's scorecard: a key, its words, and its top mark. */
export type ScorecardKey = { key: string; label: string; max: number };

export type QueueRow = {
  id: string;
  title: string;
  abstract: string | null;
  format: string;
  minutes: number;
  level: string | null;
  track: { slug: string; name: string; colour: string } | null;
  /** When the speaker sent it in — the only date on the row that is not mine. */
  waitingSince: number | null;
  /** My marks for this round, key by key. Empty when I have not scored it. */
  myScores: Record<string, number>;
  myNote: string | null;
  /** Set once I have submitted: this round's marks are fixed from then on. */
  mySubmittedAt: number | null;
  /** Mine, scored, and still only mine. */
  staged: boolean;
};

export type ReviewQueue = {
  eventId: string;
  round: number;
  scorecard: ScorecardKey[];
  rows: QueueRow[];
  /** What this screen is answerable for: my assignments, or the whole pile. */
  total: number;
  /** How many of `total` are on screen right now. */
  shown: number;
  /** Handed to me this round, whichever view I am reading in. */
  assigned: number;
  /** Handed to me this round on ANY proposal, decided since or not. */
  mine: number;
  /** Of `mine`, the ones I sent to the committee. */
  mineDone: number;
  /** Every undecided proposal on this event — the chair's number, not mine. */
  pile: number;
  /** True when I am reading the whole pile rather than my own list. */
  everything: boolean;
  /** Mine, scored, not yet submitted — the two-pass number. */
  staged: number;
  /** Mine, submitted, this round. */
  submitted: number;
  /** Still owed a mark from me: total less what I have already submitted. */
  left: number;
};

/**
 * One person on the committee, and how their round is going (ABS-08). The
 * chair reads this table to answer the only two questions a hand-out raises:
 * who is carrying what, and who has finished.
 */
export type TeamReader = {
  personId: string;
  name: string;
  /** Their standing here: an event role, or 'organizer' install-wide. */
  standing: string;
  /** Handed to them this round, on proposals still undecided. */
  assigned: number;
  /** Of those, submitted to the committee. */
  completed: number;
  /** Of those, marked but not yet submitted — somebody's evening in progress. */
  started: number;
  /** Of those, never opened: the only ones that can be taken back. */
  untouched: number;
  isYou: boolean;
};

/** A staged review as the confirm pass reads it back, before it goes. */
export type StagedReview = {
  submissionId: string;
  title: string;
  scores: Record<string, number>;
  note: string | null;
};

export type ReviewEvent = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  tzLabel: string | null;
  round: number;
  scorecard: ScorecardKey[];
  /** This person reads the whole pile and may hand it out. See seesEverything. */
  everything: boolean;
};

/* ------------------------------------------------------------------ *
 * Shapes and helpers
 * ------------------------------------------------------------------ */

function rowsOf<T>(res: D1Result<Record<string, unknown>> | undefined): T[] {
  return (res?.results ?? []) as unknown as T[];
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

function asScores(text: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(asObject(text))) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * The window a reviewer reads in one sitting, and its ceiling.
 *
 * The ceiling is not a limit on the work — it is a limit on one page. The
 * order below puts finished reviews last, so submitting a batch drops those
 * rows out of the window and the next oldest proposals move up into it: the
 * queue walks the whole pile a sitting at a time without ever building a
 * thousand-row screen.
 */
export const PAGE = 20;
export const MOST = 100;

export function windowSize(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return PAGE;
  return Math.max(PAGE, Math.min(MOST, Math.floor(n / PAGE) * PAGE || PAGE));
}

/**
 * The scorecard for one round, out of event.round_scorecards.
 *
 * Stored shape: `{"1":[{"key":"fit","label":"Fit for this room","max":5}]}`.
 * An event that has never written one — DevOps Days Charlotte stores `{}` —
 * falls back to a single overall mark, because a committee with no scorecard
 * still has an opinion, and a screen with no scales is a screen that cannot
 * be used.
 */
export function scorecardFor(stored: string | null, round: number): ScorecardKey[] {
  const raw = asObject(stored)[String(round)];
  const out: ScorecardKey[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const key = typeof o.key === 'string' ? o.key.trim() : '';
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || seen.has(key)) continue;
      seen.add(key);
      const words = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : key;
      const max =
        typeof o.max === 'number' && o.max >= 2 && o.max <= 10 ? Math.floor(o.max) : 5;
      out.push({ key, label: words, max });
    }
  }
  if (out.length === 0) out.push({ key: 'overall', label: 'Overall', max: 5 });
  return out;
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

type EventSqlRow = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  tz_label: string | null;
  current_round: number;
  round_scorecards: string | null;
};

/**
 * The event a reviewer is scoring, by its address, with this round's scorecard
 * already parsed. Throws ScopeError when the person holds no standing here;
 * returns null when there is no such event, which the screen answers with the
 * same refusal — an address that is not yours and an address that is not
 * anybody's should not read differently from outside.
 */
export async function reviewEvent(
  db: D1Database,
  principal: Principal,
  slug: string
): Promise<ReviewEvent | null> {
  const row = await db
    .prepare(
      `SELECT id, slug, name, timezone, tz_label, current_round, round_scorecards
         FROM event WHERE slug = ?`
    )
    .bind(slug)
    .first<EventSqlRow>();
  if (!row) return null;
  requireScope(principal, row.id, READ_ROLES);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    timezone: row.timezone,
    tzLabel: row.tz_label,
    round: row.current_round,
    scorecard: scorecardFor(row.round_scorecards, row.current_round),
    everything: seesEverything(principal, row.id),
  };
}

type QueueSqlRow = {
  id: string;
  title: string;
  abstract: string | null;
  format: string;
  requested_min: number;
  level: string | null;
  submitted_at: number | null;
  track_slug: string | null;
  track_name: string | null;
  track_colour: string | null;
  my_scores: string | null;
  my_note: string | null;
  my_submitted_at: number | null;
  staged: number;
};

type QueueCountRow = { pile: number; assigned: number; submitted: number; staged: number };

/**
 * My queue for this round: what was handed to me, mine-first.
 *
 * THE ASSIGNMENT PREDICATE IS THE JOIN. `rv.id IS NOT NULL` turns the outer
 * join into "proposals with a review row for me this round", which is the
 * whole of the fix: a reviewer cannot be shown a proposal nobody gave her,
 * because it never comes back from the database. The one relaxation is
 * `event.everything`, and it is not a query-string opt-in — it is the standing
 * that lets a person decide, read once, in reviewEvent.
 *
 * The order is the evening's own: what I have staged and not finished sits at
 * the top, then what I have not touched, then what I have already submitted —
 * so the boundary between "done for now" and "next" is one line on the screen,
 * and finished work sinks out of the way instead of being scrolled past twice.
 * Within each group the longest-waiting proposal comes first.
 *
 * Windowed, because the chair's view of a thousand-proposal call is three
 * hundred rows and page weight is a product requirement. `total` is always the
 * truth for the view being read; `shown` is what came back.
 */
export async function reviewQueue(
  db: D1Database,
  principal: Principal,
  event: ReviewEvent,
  opts: { show?: number } = {}
): Promise<ReviewQueue> {
  requireScope(principal, event.id, READ_ROLES);
  const show = Math.max(PAGE, Math.min(MOST, Math.floor(opts.show ?? PAGE)));

  const MINE = 'rv.reviewer_person_id = ?2 AND rv.round = ?3';
  const ASSIGNED_TO_ME = event.everything ? '' : ' AND rv.id IS NOT NULL';

  const [rowRes, countRes, mineRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT s.id, s.title, s.abstract, s.format, s.requested_min, s.level, s.submitted_at,
                t.slug AS track_slug, t.name AS track_name, t.colour AS track_colour,
                rv.scores AS my_scores, rv.note AS my_note,
                rv.submitted_at AS my_submitted_at,
                CASE WHEN rv.id IS NOT NULL AND ${MY_STAGED_SQL} THEN 1 ELSE 0 END AS staged
           FROM submission s
           LEFT JOIN track t ON t.id = s.track_id
           LEFT JOIN review rv ON rv.submission_id = s.id AND ${MINE}
          WHERE s.event_id = ?1 AND s.state = 'submitted'${ASSIGNED_TO_ME}
          ORDER BY staged DESC,
                   CASE WHEN rv.submitted_at IS NOT NULL THEN 1 ELSE 0 END,
                   s.submitted_at IS NULL, s.submitted_at, s.id
          LIMIT ?4`
      )
      .bind(event.id, principal.personId, event.round, show),
    // Both numbers in one pass over the same predicate, so "yours" and "the
    // whole pile" can never be counted from two different piles.
    db
      .prepare(
        `SELECT COUNT(*) AS pile,
                COUNT(rv.id) AS assigned,
                COUNT(CASE WHEN rv.submitted_at IS NOT NULL THEN 1 END) AS submitted,
                COUNT(CASE WHEN rv.id IS NOT NULL AND ${MY_STAGED_SQL} THEN 1 END) AS staged
           FROM submission s
           LEFT JOIN review rv ON rv.submission_id = s.id AND ${MINE}
          WHERE s.event_id = ?1 AND s.state = 'submitted'`
      )
      .bind(event.id, principal.personId, event.round),
    // My whole round, decided proposals included. A reviewer whose committee
    // decided everything she read has an empty list and a finished evening,
    // and those are two different silences (see the empty states).
    db
      .prepare(
        `SELECT COUNT(*) AS mine, COUNT(rv.submitted_at) AS mine_done
           FROM review rv
           JOIN submission s ON s.id = rv.submission_id
          WHERE s.event_id = ?1 AND rv.reviewer_person_id = ?2 AND rv.round = ?3`
      )
      .bind(event.id, principal.personId, event.round),
  ]);

  const c = rowsOf<QueueCountRow>(countRes)[0];
  const mineCounts = rowsOf<{ mine: number; mine_done: number }>(mineRes)[0];
  const pile = c?.pile ?? 0;
  const assigned = c?.assigned ?? 0;
  const total = event.everything ? pile : assigned;
  const submitted = c?.submitted ?? 0;
  const rows = rowsOf<QueueSqlRow>(rowRes).map((r) => ({
    id: r.id,
    title: r.title,
    abstract: r.abstract,
    format: r.format,
    minutes: r.requested_min,
    level: r.level,
    track:
      r.track_slug && r.track_name && r.track_colour
        ? { slug: r.track_slug, name: r.track_name, colour: r.track_colour }
        : null,
    waitingSince: r.submitted_at,
    myScores: asScores(r.my_scores),
    myNote: r.my_note,
    mySubmittedAt: r.my_submitted_at,
    staged: r.staged === 1,
  }));

  return {
    eventId: event.id,
    round: event.round,
    scorecard: event.scorecard,
    rows,
    total,
    shown: rows.length,
    assigned,
    mine: mineCounts?.mine ?? 0,
    mineDone: mineCounts?.mine_done ?? 0,
    pile,
    everything: event.everything,
    staged: c?.staged ?? 0,
    submitted,
    left: total - submitted,
  };
}

type TeamSqlRow = {
  person_id: string;
  name: string;
  event_role: string | null;
  internal_role: string | null;
  assigned: number;
  completed: number;
  started: number;
  untouched: number;
};

/**
 * Who reads what — the committee, and where each of them stands this round.
 *
 * The set is everyone who can already read this event's proposals: a role on
 * this event, or the install-wide organizer standing that opens every door.
 * Nobody else appears, because handing a proposal to a person who cannot open
 * it would be a promise the screen could not keep — and the write guards on
 * the same two facts, so the list and the hand-out agree.
 *
 * Counts are round-scoped and restricted to proposals still undecided: a
 * reviewer's work on a proposal the chair decided last night is finished
 * business, not a chore still owed.
 */
export async function reviewTeam(
  db: D1Database,
  principal: Principal,
  event: ReviewEvent
): Promise<TeamReader[]> {
  requireScope(principal, event.id, READ_ROLES);
  const res = await db
    .prepare(
      `SELECT p.id AS person_id, p.name, er.role AS event_role, p.internal_role,
              COUNT(rv.id) AS assigned,
              COUNT(rv.submitted_at) AS completed,
              COUNT(CASE WHEN rv.id IS NOT NULL AND ${MY_STAGED_SQL} THEN 1 END) AS started,
              COUNT(CASE WHEN rv.id IS NOT NULL AND ${UNTOUCHED_SQL} THEN 1 END) AS untouched
         FROM person p
         LEFT JOIN event_role er ON er.event_id = ?1 AND er.person_id = p.id
         LEFT JOIN review rv ON rv.reviewer_person_id = p.id AND rv.round = ?2
              AND rv.submission_id IN (SELECT s.id FROM submission s
                                        WHERE s.event_id = ?1 AND s.state = 'submitted')
        WHERE er.person_id IS NOT NULL OR p.internal_role = 'organizer'
        GROUP BY p.id
        ORDER BY CASE COALESCE(er.role, 'organizer')
                   WHEN 'organizer' THEN 0 WHEN 'owner' THEN 1 WHEN 'approver' THEN 2
                   WHEN 'editor' THEN 3 ELSE 4 END, p.name`
    )
    .bind(event.id, event.round)
    .all<TeamSqlRow>();
  return res.results.map((r) => ({
    personId: r.person_id,
    name: r.name,
    standing: r.event_role ?? 'organizer',
    assigned: r.assigned,
    completed: r.completed,
    started: r.started,
    untouched: r.untouched,
    isYou: r.person_id === principal.personId,
  }));
}

/**
 * Exactly what the confirm pass reads back — the staged cohort, whole, in the
 * order it will go. Same predicate as the count on the masthead and the same
 * predicate as the update in workflows/review.ts, so the three cannot drift.
 */
export async function stagedReviews(
  db: D1Database,
  principal: Principal,
  eventId: string,
  round: number
): Promise<StagedReview[]> {
  requireScope(principal, eventId, READ_ROLES);
  const res = await db
    .prepare(
      `SELECT rv.submission_id, s.title, rv.scores, rv.note
         FROM review rv
         JOIN submission s ON s.id = rv.submission_id
        WHERE s.event_id = ?1 AND s.state = 'submitted'
          AND rv.reviewer_person_id = ?2 AND rv.round = ?3
          AND ${MY_STAGED_SQL}
        ORDER BY s.submitted_at IS NULL, s.submitted_at, s.id`
    )
    .bind(eventId, principal.personId, round)
    .all<{ submission_id: string; title: string; scores: string | null; note: string | null }>();
  return res.results.map((r) => ({
    submissionId: r.submission_id,
    title: r.title,
    scores: asScores(r.scores),
    note: r.note,
  }));
}
