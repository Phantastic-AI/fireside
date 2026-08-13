// The reviewer's read layer (R-11) — round-scoped, and blind by default.
//
// BLIND IS A PROPERTY OF THIS FILE, not of the template that renders it. The
// row-list statement in reviewQueue never joins `participation` or `person`
// unless it has already checked event.roundConfig.blind and found it false
// for the round being read — the one round-scoped exception, ABS-07's per-
// round anonymization setting (event.round_config, schema/0007). Every round
// with no entry in that column, which is every round written before this
// column existed, reads back blind: the fallback in roundConfigFor is `true`,
// not `false`, so an upgrade cannot un-blind a round nobody touched. A screen
// built on a blind round still cannot show a name it was never given, because
// the fact never reaches it — that is the same discipline queries/admin.ts
// applies to scope: the read is the chokepoint, and a template's good
// intentions are not a security model. See the note beside the join itself,
// a few hundred lines down, for exactly what widens and why.
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
// THE SEARCH IS BLIND TOO. A queue row shows a title, so the search reads a
// title — see TITLE_MATCHES. A predicate that reached `participation` for a
// name would put an author's identity inside a blind read without leaving a
// mark on the screen, which is the quietest way this file could be undone.
//
// Scope is REVIEW_ROLES, and this file is the only one that uses it: every
// backstage standing that may read, plus 'reviewer', the standing that is the
// reading room and nothing else. READ_ROLES stays narrower on purpose — the
// pile, the proposals and the people carry the names a blind round exists to
// keep out — so a person whose whole standing is reading passes here and is
// refused everywhere else. Lena Fischer walks in through this line, and
// `everything` below stays false for her: deciding is what opens the pile, and
// 'reviewer' does not decide.
//
// TWO FACTS THIS FILE ADDED WHEN THE ROOM GREW, both of them shapes rather
// than columns, because the schema is the one thing a deadline should not be
// allowed to move:
//
//   STEPPING ASIDE is a submitted review with nothing in it (RECUSED_SQL).
//   Nothing else in the product can produce that shape, so it needs no flag —
//   and because every average is taken over the marks themselves, a reviewer
//   who knows the speaker removes her voice instead of adding a quiet zero.
//
//   WEIGHT is a number on a scorecard line, and it reaches arithmetic in
//   exactly one place: weightedAverage below. Words are never averaged, and a
//   line nobody marked is a missing opinion rather than a nought.

import type { Principal } from '../workflows/account';
import { requireScope, REVIEW_ROLES, type SubmissionState } from './admin';
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

/**
 * THE ONE EXPRESSION for "stepped aside" — a review that was finished without
 * a mark in it. A reviewer who knows the speaker says so, and the row is
 * closed with nothing inside: no marks, a note that says what happened, and a
 * finish time that fixes it for the round like any other submitted review.
 *
 * The shape is unambiguous on purpose. Submitting never sends an empty review
 * — the cohort in workflows/review.ts requires MY_STAGED_SQL, which requires
 * marks — so a submitted review with no marks in it can only have got there
 * one way. It also means an empty review contributes nothing to any average,
 * because every average is taken over the marks themselves: stepping aside
 * removes a voice rather than adding a quiet zero.
 *
 * Requires the review to be aliased `rv`.
 */
export const RECUSED_SQL =
  "rv.submitted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(rv.scores))";

/** The complement inside submitted_at: a review that was finished WITH marks. */
export const SCORED_SQL =
  "rv.submitted_at IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(rv.scores))";

/**
 * The one subject a nudge ever carries, and the window one lands in.
 *
 * Both live here rather than in the writer because the screen has to know them
 * to answer "has this person been nudged today?" before it offers the button,
 * and the writer has to know them to refuse a second one. One string, one
 * number, both readers.
 */
export const NUDGE_SUBJECT = 'Your reviews are waiting';
export const NUDGE_HOURS = 20;

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

/**
 * How much one line of the scorecard counts when the marks are averaged:
 * Light, Normal, Heavy. Stored as a number so the arithmetic is arithmetic.
 */
export type ScorecardWeight = 1 | 2 | 3;

/** The three ways a committee answers one line. Only one of them is a number. */
export type ScorecardKind = 'scale' | 'select' | 'text';

/**
 * One line of the round's scorecard: a key, its words, how it is answered, and
 * how much it counts.
 *
 * `max` belongs to a scale and is left at 5 for the other two, where nothing
 * reads it. `options` belongs to a select and is empty elsewhere. `weight`
 * reaches the arithmetic only through a scale, because words are not numbers
 * to average — see weightedAverage below, which is the only place the two
 * facts meet.
 */
export type ScorecardKey = {
  key: string;
  label: string;
  kind: ScorecardKind;
  max: number;
  options: string[];
  weight: ScorecardWeight;
};

/** A mark: a number off a scale, or the words a select or a text answer left. */
export type ScoreValue = number | string;
export type Scores = Record<string, ScoreValue>;

/** One name on a proposal, only ever read when a round has said out loud that
 *  it is not blind — see reviewQueue's ASSIGNED_TO_ME/authors note below. */
export type QueueAuthor = { name: string; role: string; organisation: string | null };

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
  myScores: Scores;
  myNote: string | null;
  /** Set once I have submitted: this round's marks are fixed from then on. */
  mySubmittedAt: number | null;
  /** Mine, scored, and still only mine. */
  staged: boolean;
  /** Finished with nothing in it: I know this speaker and stepped aside. */
  myRecused: boolean;
  /**
   * Who wrote this, in participation order — null on every blind round, by
   * construction: reviewQueue only runs the query that reaches `participation`
   * when event.roundConfig.blind is false for the round being read. A blind
   * round never has this field populated, whatever the caller asks for.
   */
  authors: QueueAuthor[] | null;
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
  /** The search this list was read under, case-folded. Empty when there is none. */
  q: string;
  /** Rows the search reaches inside this view. Equals `total` with no search. */
  matching: number;
  /** The page on screen, 1-based, and how many pages `matching` makes. */
  page: number;
  pages: number;
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
  /** Mine, sent in with marks in them, this round. */
  submitted: number;
  /** Mine, finished by stepping aside, this round. Never called "scored". */
  recused: number;
  /** Still owed something from me: neither marked and sent, nor stepped away from. */
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
  /** Of those, sent in with marks in them. */
  completed: number;
  /** Of those, finished by stepping aside — done, and counted in no average. */
  recused: number;
  /** Of those, marked but not yet submitted — somebody's evening in progress. */
  started: number;
  /** Of those, never opened: the only ones that can be taken back. */
  untouched: number;
  /** When they were last nudged about this conference, if they have been. */
  nudgedAt: number | null;
  isYou: boolean;
};

/** Where a round stands, as the chair reads it before opening the next one. */
export type RoundStanding = {
  round: number;
  /** Reviews sent in with marks this round — what stays on the record. */
  onRecord: number;
  /** Reviews finished by stepping aside this round. */
  stepped: number;
  /**
   * Undecided proposals with no review row at all this round — nobody's list.
   *
   * This is the number that makes "this one is on nobody's list" and "327
   * assigned" true on the same evening: a hand-out is a deliberate act on the
   * pile as it stood, and everything that arrives afterwards waits here until
   * somebody hands it out. Nothing auto-assigns; the screen says the number.
   */
  unassigned: number;
  /** True when the next round already has a scorecard written for it. */
  nextCardExists: boolean;
};

/** A staged review as the confirm pass reads it back, before it goes. */
export type StagedReview = {
  submissionId: string;
  title: string;
  scores: Scores;
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
  /** Every round's scorecard as stored, so the round panel can see ahead. */
  scorecardsRaw: string;
  /** Every round's name, dates and blind setting as stored — round history
   *  reads every round out of this, not only the current one. */
  roundConfigRaw: string;
  /** This round's own config, already resolved — reviewQueue reads `blind`
   *  off this rather than re-parsing roundConfigRaw itself. */
  roundConfig: RoundConfig;
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

/**
 * The marks on one review. A number is a mark off a scale; a string is the
 * word a select left or the line or two a text answer left. Anything else was
 * never written by this product and is dropped rather than rendered.
 */
function asScores(text: string | null): Scores {
  const out: Scores = {};
  for (const [k, v] of Object.entries(asObject(text))) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v.trim() !== '') out[k] = v.slice(0, TEXT_MARK_MAX);
  }
  return out;
}

/** How long one written mark may be — a line or two, not a second abstract. */
export const TEXT_MARK_MAX = 600;

/**
 * One page of the queue, and the furthest page an address may ask for.
 *
 * Fifty rows is a sitting, and it is what a phone can carry in one round trip.
 * Three hundred rows on one page is not a queue, it is a wall — which is what
 * a reviewer holding a whole call was handed before this was a number.
 *
 * Paging is by page number rather than by a window that grows, because a
 * reviewer who saves a mark has to come back to the rows she was reading, and
 * a page number survives that round trip where a window size cannot.
 */
export const PAGE = 50;

/** A ceiling on the offset, not on the work: past this the address is noise. */
export const MOST_PAGES = 400;

export function pageNumber(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MOST_PAGES, n);
}

/** The longest search this file carries. A pasted title is shorter than this. */
export const SEARCH_MAX = 120;

/**
 * The search, case-folded for instr(). Not LIKE: D1 refuses a bound LIKE
 * pattern much past 50 bytes ("pattern too complex"), and a pasted title is
 * longer than that. instr has no pattern language, so nothing needs escaping.
 */
export function needleOf(raw: string | undefined): string {
  return (raw ?? '').trim().slice(0, SEARCH_MAX).toLowerCase();
}

/** The most lines one round's scorecard may carry, and the most choices one. */
export const MOST_CRITERIA = 12;
export const MOST_CHOICES = 12;

const KINDS: readonly ScorecardKind[] = ['scale', 'select', 'text'];

/** A key that survives a form field name and a JSON key without escaping. */
export const CRITERION_KEY = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * The scorecard for one round, out of event.round_scorecards.
 *
 * Stored shape, one entry per round:
 *   `{"1":[{"key":"fit","label":"Fit for this room","kind":"scale","weight":2}]}`
 *
 * A 'select' carries its own `options`; a 'text' carries neither options nor a
 * top mark. THE OLD SHAPE STILL READS: an entry written before there were
 * kinds carries only `max`, and comes back as a scale of normal weight — the
 * scorecards the seed wrote are that shape, and an editor that quietly dropped
 * them would take a committee's own words off their screen.
 *
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
      if (out.length >= MOST_CRITERIA) break;
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const key = typeof o.key === 'string' ? o.key.trim() : '';
      if (!CRITERION_KEY.test(key) || seen.has(key)) continue;
      seen.add(key);
      const words = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : key;
      const max =
        typeof o.max === 'number' && o.max >= 2 && o.max <= 10 ? Math.floor(o.max) : 5;
      const kind =
        typeof o.kind === 'string' && (KINDS as readonly string[]).includes(o.kind)
          ? (o.kind as ScorecardKind)
          : 'scale';
      const options =
        kind === 'select' && Array.isArray(o.options)
          ? o.options
              .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
              .map((c) => c.trim())
              .slice(0, MOST_CHOICES)
          : [];
      // A weight nobody has said out loud is the ordinary one, which is what
      // every scorecard written before weights existed meant by saying nothing.
      const weight: ScorecardWeight =
        o.weight === 1 || o.weight === 3 ? (o.weight as ScorecardWeight) : 2;
      // A select with nothing to pick from is not answerable, so it reads as
      // the words it was going to be — never as a broken control.
      out.push({
        key,
        label: words,
        kind: kind === 'select' && options.length < 2 ? 'text' : kind,
        max,
        options,
        weight,
      });
    }
  }
  if (out.length === 0) {
    out.push({ key: 'overall', label: 'Overall', kind: 'scale', max: 5, options: [], weight: 2 });
  }
  return out;
}

/**
 * One round's own identity: a name, a date range, and whether it is blind —
 * everything about a round that used to be nothing but its integer.
 *
 * Stored on event.round_config, the same discipline round_scorecards already
 * keeps: one JSON object keyed by round number as a string, and a round with
 * no entry — every round written before this column existed — reads back as
 * the product's original defaults: no name (the screen falls back to "Round
 * N"), no dates, and blind, because blind used to be the only behaviour there
 * was and an upgrade must not un-blind a round nobody touched.
 */
export type RoundConfig = {
  name: string | null;
  opensAt: number | null;
  closesAt: number | null;
  /** Absent or anything but `false` reads as blind — the same "say so on
   *  purpose to change it" rule scorecardFor's weight fallback uses. */
  blind: boolean;
};

/** How long a round's own name may run — a line, not a paragraph. */
export const ROUND_NAME_MAX = 80;

export function roundConfigFor(stored: string | null, round: number): RoundConfig {
  const raw = asObject(stored)[String(round)];
  const o =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const name =
    typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, ROUND_NAME_MAX) : null;
  const opensAt = typeof o.opensAt === 'number' && Number.isFinite(o.opensAt) ? o.opensAt : null;
  const closesAt =
    typeof o.closesAt === 'number' && Number.isFinite(o.closesAt) ? o.closesAt : null;
  return { name, opensAt, closesAt, blind: o.blind !== false };
}

/**
 * The weighted average of one set of marks: sum of w·score over sum of w,
 * across the numbered lines only.
 *
 * Words are not averaged. A select and a text answer say something the room
 * reads, not something the room adds up, so they carry no weight into this —
 * and neither does a line the reviewer left blank, because a missing mark is
 * a missing opinion rather than a zero. Null when nothing numbered was marked.
 */
export function weightedAverage(card: ScorecardKey[], scores: Scores): number | null {
  let top = 0;
  let bottom = 0;
  for (const k of card) {
    if (k.kind !== 'scale') continue;
    const v = scores[k.key];
    if (typeof v !== 'number') continue;
    top += k.weight * v;
    bottom += k.weight;
  }
  return bottom === 0 ? null : top / bottom;
}

/** One average, and whether the word "weighted" is true of it. */
export type MarksAverage = { value: number; weighted: boolean };

/**
 * The same arithmetic, with the one fact the screen needs to name it.
 *
 * "3.3 weighted" over 4, 2 and 4 on a card where every line counts the same is
 * a plain mean wearing a word it has not earned — the weights are all 2, so
 * nothing was weighted by anything. A committee reading that has been told
 * their scorecard is doing something it is not. `weighted` is true only when
 * the lines this reviewer actually marked carry more than one weight between
 * them, because a heavy line nobody answered weights nothing.
 */
export function averageOf(card: ScorecardKey[], scores: Scores): MarksAverage | null {
  const value = weightedAverage(card, scores);
  if (value === null) return null;
  const weights = new Set<number>();
  for (const k of card) {
    if (k.kind === 'scale' && typeof scores[k.key] === 'number') weights.add(k.weight);
  }
  return { value, weighted: weights.size > 1 };
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
  round_config: string | null;
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
      `SELECT id, slug, name, timezone, tz_label, current_round, round_scorecards, round_config
         FROM event WHERE slug = ?`
    )
    .bind(slug)
    .first<EventSqlRow>();
  if (!row) return null;
  requireScope(principal, row.id, REVIEW_ROLES);
  const roundConfigRaw = row.round_config ?? '{}';
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    timezone: row.timezone,
    tzLabel: row.tz_label,
    round: row.current_round,
    scorecard: scorecardFor(row.round_scorecards, row.current_round),
    scorecardsRaw: row.round_scorecards ?? '{}',
    roundConfigRaw,
    roundConfig: roundConfigFor(roundConfigRaw, row.current_round),
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
  recused: number;
};

type QueueCountRow = {
  pile: number;
  assigned: number;
  submitted: number;
  recused: number;
  staged: number;
};

/**
 * THE ONE ORDER the queue is read in, and the one a deep link counts positions
 * against. Two statements order by these names; if they ever ordered by two
 * different strings, "page 4 of the list" and "the page this proposal is on"
 * would name different pages, and the ?open= link would land beside its own
 * scorecard rather than on it.
 *
 * The order is the evening's own: what I have staged and not finished sits at
 * the top, then what I have not touched, then what I have already submitted —
 * so the boundary between "done for now" and "next" is one line on the screen.
 * Within each group the longest-waiting proposal comes first.
 *
 * The keys are computed as named columns rather than repeated inside each
 * ORDER BY, because the position count wraps them in a window function and a
 * window is the last place a long expression should be written twice.
 */
const QUEUE_ORDER_COLUMNS =
  `CASE WHEN rv.id IS NOT NULL AND ${MY_STAGED_SQL} THEN 0 ELSE 1 END AS o_staged,
   CASE WHEN rv.submitted_at IS NOT NULL THEN 1 ELSE 0 END AS o_done,
   s.submitted_at IS NULL AS o_nodate,
   s.submitted_at AS o_waited`;

/**
 * The same order, by the names above, with the last tie broken on the proposal
 * itself. The id is named by the caller because the list query joins three
 * tables that all have one — a bare `id` there is ambiguous, and SQLite says so
 * rather than guessing.
 */
const QUEUE_ORDER_BY = (id: string): string =>
  `o_staged, o_done, o_nodate, o_waited, ${id}`;

/**
 * The search, over the title and nothing else.
 *
 * A search may only read what the row it filters already shows, and a queue row
 * shows a title. Reaching into `participation` for a name here would put an
 * author's identity inside a blind read — the exact fact this file exists to
 * keep out — and it would do it invisibly, because a search predicate leaves no
 * mark on the screen. It stays title-only in the chair's view as well: she has
 * the proposals list for names, and one predicate is one thing to be sure of.
 */
const TITLE_MATCHES = (param: string): string => `instr(lower(s.title), ${param}) > 0`;

/**
 * My queue for this round: what was handed to me, mine-first, one page at a
 * time, and only what a search reaches when one is asked for.
 *
 * THE ASSIGNMENT PREDICATE IS THE JOIN. `rv.id IS NOT NULL` turns the outer
 * join into "proposals with a review row for me this round", which is the
 * whole of the fix: a reviewer cannot be shown a proposal nobody gave her,
 * because it never comes back from the database. The one relaxation is
 * `event.everything`, and it is not a query-string opt-in — it is the standing
 * that lets a person decide, read once, in reviewEvent.
 *
 * Paged, because a call of three hundred proposals is three hundred scorecards
 * and page weight is a product requirement. `total` is the truth for the view
 * being read whatever the search says, `matching` is what the search reaches,
 * and `shown` is what came back on this page — three numbers, because a
 * masthead that changed its counts when somebody typed would be lying about
 * the evening.
 */
export async function reviewQueue(
  db: D1Database,
  principal: Principal,
  event: ReviewEvent,
  opts: { page?: number; q?: string } = {}
): Promise<ReviewQueue> {
  requireScope(principal, event.id, REVIEW_ROLES);
  const page = Math.max(1, Math.min(MOST_PAGES, Math.floor(opts.page ?? 1)));
  const needle = needleOf(opts.q);
  const offset = (page - 1) * PAGE;

  const MINE = 'rv.reviewer_person_id = ?2 AND rv.round = ?3';
  const ASSIGNED_TO_ME = event.everything ? '' : ' AND rv.id IS NOT NULL';

  const rowStatement = db
    .prepare(
      `SELECT s.id, s.title, s.abstract, s.format, s.requested_min, s.level, s.submitted_at,
                t.slug AS track_slug, t.name AS track_name, t.colour AS track_colour,
                rv.scores AS my_scores, rv.note AS my_note,
                rv.submitted_at AS my_submitted_at,
                CASE WHEN rv.id IS NOT NULL AND ${MY_STAGED_SQL} THEN 1 ELSE 0 END AS staged,
                CASE WHEN rv.id IS NOT NULL AND ${RECUSED_SQL} THEN 1 ELSE 0 END AS recused,
                ${QUEUE_ORDER_COLUMNS}
           FROM submission s
           LEFT JOIN track t ON t.id = s.track_id
           LEFT JOIN review rv ON rv.submission_id = s.id AND ${MINE}
          WHERE s.event_id = ?1 AND s.state = 'submitted'${ASSIGNED_TO_ME}` +
        (needle ? ` AND ${TITLE_MATCHES('?6')}` : '') +
        ` ORDER BY ${QUEUE_ORDER_BY('s.id')}
          LIMIT ?4 OFFSET ?5`
    )
    // Bound exactly as far as the statement reaches: a value bound to a
    // placeholder the SQL does not carry is an error, not a spare.
    .bind(
      ...(needle
        ? [event.id, principal.personId, event.round, PAGE, offset, needle]
        : [event.id, principal.personId, event.round, PAGE, offset])
    );

  const statements = [
    rowStatement,
    // Both numbers in one pass over the same predicate, so "yours" and "the
    // whole pile" can never be counted from two different piles.
    db
      .prepare(
        `SELECT COUNT(*) AS pile,
                COUNT(rv.id) AS assigned,
                COUNT(CASE WHEN rv.id IS NOT NULL AND ${SCORED_SQL} THEN 1 END) AS submitted,
                COUNT(CASE WHEN rv.id IS NOT NULL AND ${RECUSED_SQL} THEN 1 END) AS recused,
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
        `SELECT COUNT(*) AS mine,
                COUNT(CASE WHEN ${SCORED_SQL} THEN 1 END) AS mine_done
           FROM review rv
           JOIN submission s ON s.id = rv.submission_id
          WHERE s.event_id = ?1 AND rv.reviewer_person_id = ?2 AND rv.round = ?3`
      )
      .bind(event.id, principal.personId, event.round),
  ];

  // The fourth statement exists only when somebody typed. With no search the
  // whole view matches, and counting that twice would be a round trip spent
  // proving what the count above already says.
  if (needle) {
    statements.push(
      db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM submission s
             LEFT JOIN review rv ON rv.submission_id = s.id AND ${MINE}
            WHERE s.event_id = ?1 AND s.state = 'submitted'${ASSIGNED_TO_ME}
              AND ${TITLE_MATCHES('?4')}`
        )
        .bind(event.id, principal.personId, event.round, needle)
    );
  }

  const answered = await db.batch<Record<string, unknown>>(statements);
  const rowRes = answered[0];
  const countRes = answered[1];
  const mineRes = answered[2];
  const matchRes = answered[3];

  const c = rowsOf<QueueCountRow>(countRes)[0];
  const mineCounts = rowsOf<{ mine: number; mine_done: number }>(mineRes)[0];
  const pile = c?.pile ?? 0;
  const assigned = c?.assigned ?? 0;
  const total = event.everything ? pile : assigned;
  const submitted = c?.submitted ?? 0;
  const recused = c?.recused ?? 0;
  const rows: QueueRow[] = rowsOf<QueueSqlRow>(rowRes).map((r) => ({
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
    myRecused: r.recused === 1,
    authors: null,
  }));

  // THE ONE PLACE THIS FILE EVER READS A NAME. It runs only when the round
  // being read has said, on its own config, that it is not blind — every
  // other round takes the branch above and never builds this statement, so a
  // blind round still cannot show a name it never asked the database for.
  // Scoped to the ids already on this page: a committee's whole pile is never
  // read for names in one call just because one page of it is unblinded.
  if (!event.roundConfig.blind && rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const authored = await db
      .prepare(
        `SELECT pa.submission_id AS submission_id, p.name AS name, pa.role AS role,
                p.organisation AS organisation
           FROM participation pa
           JOIN person p ON p.id = pa.person_id
          WHERE pa.submission_id IN (${ids.map(() => '?').join(',')})
          ORDER BY pa.submission_id, pa.position`
      )
      .bind(...ids)
      .all<{ submission_id: string; name: string; role: string; organisation: string | null }>();
    const byId = new Map<string, QueueAuthor[]>();
    for (const a of authored.results) {
      const list = byId.get(a.submission_id) ?? [];
      list.push({ name: a.name, role: a.role, organisation: a.organisation });
      byId.set(a.submission_id, list);
    }
    for (const r of rows) r.authors = byId.get(r.id) ?? [];
  }

  const matching = needle ? (rowsOf<{ n: number }>(matchRes)[0]?.n ?? 0) : total;

  return {
    eventId: event.id,
    round: event.round,
    scorecard: event.scorecard,
    rows,
    total,
    shown: rows.length,
    q: needle,
    matching,
    page,
    pages: Math.max(1, Math.ceil(matching / PAGE)),
    assigned,
    mine: mineCounts?.mine ?? 0,
    mineDone: mineCounts?.mine_done ?? 0,
    pile,
    everything: event.everything,
    staged: c?.staged ?? 0,
    submitted,
    recused,
    // Stepping aside finishes a proposal as surely as marking it does, so it
    // comes out of what is left. A list that still said "1 to score" over a
    // proposal she has recused herself from would be asking for a mark she is
    // not allowed to give.
    left: total - submitted - recused,
  };
}

/** Where one proposal sits in the queue as this person reads it. */
export type QueueSpot = { submissionId: string; page: number };

/**
 * The page a deep link has to land on.
 *
 * A link from anywhere else in the product carries an id — a proposal's, or the
 * id of a review row on it — and the queue it points into is paged, so the id
 * alone is not an address. This counts the row's position in the queue's own
 * order — QUEUE_ORDER_BY, the names the list itself is read by — and turns it
 * into the page number that holds it. Null when the row is not in this person's
 * queue at all, which is a sentence the screen says rather than a dead end.
 *
 * A reviewer resolves only her own review rows. She would learn nothing from
 * anybody else's — this file selects no names — but an id she was never given
 * is not hers to turn into an address either.
 */
export async function queuePosition(
  db: D1Database,
  principal: Principal,
  event: ReviewEvent,
  rawId: string,
  q?: string
): Promise<QueueSpot | null> {
  requireScope(principal, event.id, REVIEW_ROLES);
  const id = rawId.trim();
  if (!id) return null;
  const needle = needleOf(q);

  const ownRow = event.everything ? '' : ' AND rv.reviewer_person_id = ?3';
  const found = await db
    .prepare(
      `SELECT s.id AS id FROM submission s
        WHERE s.event_id = ?2
          AND (s.id = ?1
               OR EXISTS (SELECT 1 FROM review rv
                           WHERE rv.id = ?1 AND rv.submission_id = s.id${ownRow}))
        LIMIT 1`
    )
    .bind(...(event.everything ? [id, event.id] : [id, event.id, principal.personId]))
    .first<{ id: string }>();
  if (!found) return null;

  const MINE = 'rv.reviewer_person_id = ?2 AND rv.round = ?3';
  const ASSIGNED_TO_ME = event.everything ? '' : ' AND rv.id IS NOT NULL';
  const spot = await db
    .prepare(
      // The order lives in one place, so the page this counts and the page the
      // list renders cannot be two different pages. The keys are computed in
      // the innermost select and the window orders by their names — plain SQL
      // rather than a subquery inside a window definition.
      `SELECT pos FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY ${QUEUE_ORDER_BY('id')}) AS pos
           FROM (SELECT s.id AS id, ${QUEUE_ORDER_COLUMNS}
                   FROM submission s
                   LEFT JOIN review rv ON rv.submission_id = s.id AND ${MINE}
                  WHERE s.event_id = ?1 AND s.state = 'submitted'${ASSIGNED_TO_ME}` +
        (needle ? ` AND ${TITLE_MATCHES('?5')}` : '') +
        `)) WHERE id = ?4`
    )
    .bind(
      ...(needle
        ? [event.id, principal.personId, event.round, found.id, needle]
        : [event.id, principal.personId, event.round, found.id])
    )
    .first<{ pos: number }>();
  if (!spot) return null;
  return { submissionId: found.id, page: Math.max(1, Math.ceil(spot.pos / PAGE)) };
}

/**
 * One proposal, as the chair reads it before handing it to one reader.
 *
 * The title only, because that is all the control needs to name what it is
 * about to hand out — and the ids of whoever already holds it this round, so
 * the picker can say "she has it" instead of offering a second copy of the same
 * row. Reviewer ids are not author identity; this stays as blind as the rest of
 * the file, and it is decider-only besides.
 */
export type HandTarget = {
  id: string;
  title: string;
  /** Undecided — the only state a proposal can be handed out in. */
  undecided: boolean;
  /** Readers already holding a row for it this round. */
  holders: string[];
};

export async function handTarget(
  db: D1Database,
  principal: Principal,
  event: ReviewEvent,
  rawId: string
): Promise<HandTarget | null> {
  requireDecider(principal, event.id);
  const id = rawId.trim();
  if (!id) return null;

  const [oneRes, heldRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare('SELECT s.id, s.title, s.state FROM submission s WHERE s.id = ?1 AND s.event_id = ?2')
      .bind(id, event.id),
    db
      .prepare(
        `SELECT rv.reviewer_person_id AS person_id FROM review rv
          WHERE rv.submission_id = ?1 AND rv.round = ?2`
      )
      .bind(id, event.round),
  ]);

  const row = rowsOf<{ id: string; title: string; state: string }>(oneRes)[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    undecided: row.state === 'submitted',
    holders: rowsOf<{ person_id: string }>(heldRes).map((r) => r.person_id),
  };
}

type TeamSqlRow = {
  person_id: string;
  name: string;
  event_role: string | null;
  internal_role: string | null;
  assigned: number;
  completed: number;
  recused: number;
  started: number;
  untouched: number;
  nudged_at: number | null;
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
 *
 * `completed` counts only reviews with marks in them, and stepping aside gets
 * its own column, because they are not the same news: one reader is six
 * proposals into an evening and another has recused herself from six. Reading
 * them as one number would have the chair chasing a person who is finished.
 */
export async function reviewTeam(
  db: D1Database,
  principal: Principal,
  event: ReviewEvent
): Promise<TeamReader[]> {
  requireScope(principal, event.id, REVIEW_ROLES);
  const res = await db
    .prepare(
      `SELECT p.id AS person_id, p.name, er.role AS event_role, p.internal_role,
              COUNT(rv.id) AS assigned,
              COUNT(CASE WHEN rv.id IS NOT NULL AND ${SCORED_SQL} THEN 1 END) AS completed,
              COUNT(CASE WHEN rv.id IS NOT NULL AND ${RECUSED_SQL} THEN 1 END) AS recused,
              COUNT(CASE WHEN rv.id IS NOT NULL AND ${MY_STAGED_SQL} THEN 1 END) AS started,
              COUNT(CASE WHEN rv.id IS NOT NULL AND ${UNTOUCHED_SQL} THEN 1 END) AS untouched,
              (SELECT MAX(m.created_at) FROM message m
                WHERE m.event_id = ?1 AND m.person_id = p.id
                  AND m.kind = 'note' AND m.subject = ?3) AS nudged_at
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
    .bind(event.id, event.round, NUDGE_SUBJECT)
    .all<TeamSqlRow>();
  return res.results.map((r) => ({
    personId: r.person_id,
    name: r.name,
    standing: r.event_role ?? 'organizer',
    assigned: r.assigned,
    completed: r.completed,
    recused: r.recused,
    started: r.started,
    untouched: r.untouched,
    nudgedAt: r.nudged_at,
    isYou: r.person_id === principal.personId,
  }));
}

/**
 * Where this round stands, in the two numbers the next one is opened against.
 *
 * Scoped to the round rather than to a person: opening round two is the
 * committee's act, and the arithmetic the chair confirms is the committee's
 * arithmetic. It counts work on every proposal, decided since or not, because
 * a review written last week about a proposal accepted on Tuesday is still on
 * the record — which is exactly what the sentence over the confirm claims.
 *
 * `nextCardExists` is read off the stored scorecards rather than guessed,
 * because whether the next round already has its own lines decides whether
 * opening it copies this round's or leaves what is already written.
 */
export async function roundStanding(
  db: D1Database,
  principal: Principal,
  event: ReviewEvent
): Promise<RoundStanding> {
  requireScope(principal, event.id, REVIEW_ROLES);
  const [standRes, waitingRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT COUNT(CASE WHEN ${SCORED_SQL} THEN 1 END) AS on_record,
                COUNT(CASE WHEN ${RECUSED_SQL} THEN 1 END) AS stepped
           FROM review rv
           JOIN submission s ON s.id = rv.submission_id
          WHERE s.event_id = ?1 AND rv.round = ?2`
      )
      .bind(event.id, event.round),
    // Undecided and in nobody's hands: the arrivals a hand-out has not reached.
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM submission s
          WHERE s.event_id = ?1 AND s.state = 'submitted'
            AND NOT EXISTS (SELECT 1 FROM review rv
                             WHERE rv.submission_id = s.id AND rv.round = ?2)`
      )
      .bind(event.id, event.round),
  ]);
  const row = rowsOf<{ on_record: number; stepped: number }>(standRes)[0];
  const next = asObject(event.scorecardsRaw)[String(event.round + 1)];
  return {
    round: event.round,
    onRecord: row?.on_record ?? 0,
    stepped: row?.stepped ?? 0,
    unassigned: rowsOf<{ n: number }>(waitingRes)[0]?.n ?? 0,
    nextCardExists: Array.isArray(next) && next.length > 0,
  };
}

/** One past or present round, as the history list reads it. */
export type RoundHistoryEntry = {
  round: number;
  name: string | null;
  opensAt: number | null;
  closesAt: number | null;
  blind: boolean;
  onRecord: number;
  stepped: number;
  readers: number;
  current: boolean;
};

/**
 * Every round the committee has ever been on, oldest first, each with its own
 * name, dates, blind setting and its own counts — the answer to "opening
 * round two hid round one's work," which it does not: nothing here is
 * deleted or overwritten when the next round opens, only current_round moves,
 * and this reads every round that number has ever pointed at.
 *
 * The set is 1..current_round. A round only ever comes to exist by being
 * opened (round 1 at event creation, every later one through openNextRound),
 * so there is no round to list past the one the committee is on, and no gap
 * inside that range either.
 */
export async function roundHistory(
  db: D1Database,
  principal: Principal,
  event: ReviewEvent
): Promise<RoundHistoryEntry[]> {
  requireDecider(principal, event.id);
  const res = await db
    .prepare(
      `SELECT rv.round AS round,
              COUNT(CASE WHEN ${SCORED_SQL} THEN 1 END) AS on_record,
              COUNT(CASE WHEN ${RECUSED_SQL} THEN 1 END) AS stepped,
              COUNT(DISTINCT rv.reviewer_person_id) AS readers
         FROM review rv
         JOIN submission s ON s.id = rv.submission_id
        WHERE s.event_id = ?1
        GROUP BY rv.round`
    )
    .bind(event.id)
    .all<{ round: number; on_record: number; stepped: number; readers: number }>();
  const counted = new Map(res.results.map((r) => [r.round, r]));

  const out: RoundHistoryEntry[] = [];
  for (let round = 1; round <= event.round; round++) {
    const c = counted.get(round);
    const cfg = roundConfigFor(event.roundConfigRaw, round);
    out.push({
      round,
      name: cfg.name,
      opensAt: cfg.opensAt,
      closesAt: cfg.closesAt,
      blind: cfg.blind,
      onRecord: c?.on_record ?? 0,
      stepped: c?.stepped ?? 0,
      readers: c?.readers ?? 0,
      current: round === event.round,
    });
  }
  return out;
}

/** The most submissions one results read carries — a ceiling on the query,
 *  not on the program: a call this size wants its results paged, and the
 *  screen says so rather than quietly truncating without a word. */
export const MOST_RESULTS = 500;

/** One submission's place in the results table. */
export type ResultsRow = {
  submissionId: string;
  title: string;
  format: string;
  state: SubmissionState;
  track: { slug: string; name: string; colour: string } | null;
  /** Mean of every scored review's own average, across every round — the same
   *  averageOf arithmetic the reviewer's own screen shows, read back once per
   *  proposal instead of once per reviewer. Null when nobody has scored it. */
  aggregate: number | null;
  weighted: boolean;
  reviewCount: number;
  /** Every select-kind mark (Accept/Maybe/Reject and the like) any scored
   *  review left, most recent first, deduplicated with a count when a value
   *  repeats — 'Accept ×2' rather than 'Accept, Accept'. */
  recommendation: string | null;
};

type ResultsSqlRow = {
  submission_id: string;
  title: string;
  format: string;
  state: SubmissionState;
  track_slug: string | null;
  track_name: string | null;
  track_colour: string | null;
  round: number | null;
  scores: string | null;
};

/**
 * The committee's own results table (ABS-10): one row per submission, its
 * aggregate score, and how many reviews stand behind it — the read the whole
 * feature was missing. Decider-only, the same standing that hands the pile
 * out and opens a round: an aggregate is committee business, not a single
 * reviewer's.
 *
 * The arithmetic happens here rather than in SQL because it is the same
 * function every other screen already trusts — averageOf, read against the
 * scorecard the review's own round actually used. A submission reviewed in
 * two rounds with two different scorecards gets one number back: the mean of
 * each round's own honest average, so a criterion that only exists on one
 * round's card is never silently averaged against a criterion it is not.
 */
export async function reviewResults(
  db: D1Database,
  principal: Principal,
  event: ReviewEvent
): Promise<{ rows: ResultsRow[]; more: boolean }> {
  requireDecider(principal, event.id);
  const res = await db
    .prepare(
      `SELECT s.id AS submission_id, s.title, s.format, s.state,
              t.slug AS track_slug, t.name AS track_name, t.colour AS track_colour,
              rv.round AS round, rv.scores AS scores
         FROM submission s
         LEFT JOIN track t ON t.id = s.track_id
         LEFT JOIN review rv ON rv.submission_id = s.id AND ${SCORED_SQL}
        WHERE s.event_id = ?1 AND s.state <> 'draft'
        ORDER BY s.id
        LIMIT ?2`
    )
    .bind(event.id, MOST_RESULTS * 20)
    .all<ResultsSqlRow>();

  const bySubmission = new Map<
    string,
    {
      title: string;
      format: string;
      state: SubmissionState;
      track: { slug: string; name: string; colour: string } | null;
      averages: MarksAverage[];
      recs: string[];
    }
  >();
  for (const r of res.results) {
    let s = bySubmission.get(r.submission_id);
    if (!s) {
      s = {
        title: r.title,
        format: r.format,
        state: r.state,
        track:
          r.track_slug && r.track_name && r.track_colour
            ? { slug: r.track_slug, name: r.track_name, colour: r.track_colour }
            : null,
        averages: [],
        recs: [],
      };
      bySubmission.set(r.submission_id, s);
    }
    if (r.round === null || r.scores === null) continue;
    const card = scorecardFor(event.scorecardsRaw, r.round);
    const scores = asScores(r.scores);
    const avg = averageOf(card, scores);
    if (avg) s.averages.push(avg);
    for (const k of card) {
      if (k.kind === 'select' && typeof scores[k.key] === 'string') {
        s.recs.push(scores[k.key] as string);
        break; // one recommendation-shaped answer per review is plenty to show
      }
    }
  }

  const rows: ResultsRow[] = [...bySubmission.entries()]
    .slice(0, MOST_RESULTS)
    .map(([id, s]) => {
      const aggregate =
        s.averages.length === 0
          ? null
          : s.averages.reduce((sum, a) => sum + a.value, 0) / s.averages.length;
      const counted = new Map<string, number>();
      for (const v of s.recs) counted.set(v, (counted.get(v) ?? 0) + 1);
      const recommendation =
        counted.size === 0
          ? null
          : [...counted.entries()].map(([v, n]) => (n > 1 ? `${v} ×${n}` : v)).join(', ');
      return {
        submissionId: id,
        title: s.title,
        format: s.format,
        state: s.state,
        track: s.track,
        aggregate,
        weighted: s.averages.some((a) => a.weighted),
        reviewCount: s.averages.length,
        recommendation,
      };
    });

  return { rows, more: bySubmission.size > MOST_RESULTS };
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
  requireScope(principal, eventId, REVIEW_ROLES);
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
