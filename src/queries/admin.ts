// The backstage read path. Every function here takes a Principal and checks it
// before it reads anything: install-wide organizers see everything, everyone
// else sees exactly the events they hold a role on (08 §1 — scope is a property
// of the chokepoint, not of a template's discipline).
//
// The one exception is `greenRoom`, which is mounted behind a share token and
// therefore takes no Principal at all; the token is the scope, and rotating
// event.green_room_nonce revokes it.

import type { Principal } from '../workflows/account';
import { eventDayKey, lifecycleOf, type Lifecycle } from './public';

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

/** Reading the pile and a proposal: every backstage standing, viewers included.
 *  'reviewer' is deliberately NOT here. That standing is the reading room and
 *  nothing else, and the pile, the proposals and the people carry the names a
 *  blind round exists to keep out of it. */
export const READ_ROLES: readonly string[] = ['owner', 'approver', 'editor', 'viewer'];
/** The reading room itself: the organizer's standings, plus the one that is
 *  only the reading. Wider than READ_ROLES on purpose — a reviewer belongs in
 *  exactly this set and no other. */
export const REVIEW_ROLES: readonly string[] = [...READ_ROLES, 'reviewer'];
/** The letters are the telling act, so a viewer does not get to read the outbox. */
export const LETTER_ROLES: readonly string[] = ['owner', 'approver', 'editor'];
/** Changing the event itself — settings, team, the agenda's shape. */
export const EDIT_ROLES: readonly string[] = ['owner', 'approver', 'editor'];

export function requireScope(principal: Principal, eventId: string, allowed: readonly string[]): void {
  if (principal.role === 'organizer') return;
  const role = principal.eventRoles[eventId];
  if (role !== undefined && allowed.includes(role)) return;
  throw new ScopeError('That conference is not one of yours.');
}

/**
 * THE ONE CANONICAL EXPRESSION for "decided but not told" (02 §1.3). Every
 * count, pill and filter in the product derives from this string and no other:
 * a decision exists the moment it is made, and it has not left the building
 * until notified_at is set. The speaker-side mirror of this rule is
 * VISIBLE_STATE_SQL in portal.ts.
 */
export const DECIDED_NOT_TOLD_SQL =
  "s.state IN ('accepted','waitlisted','rejected') AND s.notified_at IS NULL";

/** A staged decision letter for the CURRENT decision — a stale one cannot release. */
const LETTER_STAGED_SQL = `EXISTS (
  SELECT 1 FROM message m
  WHERE m.submission_id = s.id AND m.kind = 'decision'
    AND m.delivered_at IS NULL AND m.decision_version = s.decision_version)`;

/* ------------------------------------------------------------------ *
 * DTOs
 * ------------------------------------------------------------------ */

export type SubmissionState =
  | 'draft'
  | 'submitted'
  | 'accepted'
  | 'waitlisted'
  | 'rejected'
  | 'withdrawn'
  | 'cancelled';

export type AdminEvent = {
  id: string;
  slug: string;
  name: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
  tzLabel: string | null;
  lifecycle: Lifecycle;
  agendaPublished: boolean;
  cfpClosesAt: number | null;
  decideBy: string | null;
  currentRound: number;
  /** The principal's own standing here: 'organizer' install-wide, or the event role. */
  standing: string;
  counts: {
    proposals: number;
    undecided: number;
    accepted: number;
    decidedNotTold: number;
  };
};

export type PileFilter =
  | 'all'
  | 'undecided'
  | 'maybe'
  | 'accepted'
  | 'declined'
  | 'drafts'
  | 'withdrawn';

export type PileCounts = Record<PileFilter, number> & { decidedNotTold: number };

export type PileRow = {
  id: string;
  title: string;
  speaker: string | null;
  speakerCount: number;
  track: { slug: string; name: string; colour: string } | null;
  format: string;
  minutes: number;
  level: string | null;
  state: SubmissionState;
  submittedAt: number | null;
  decidedAt: number | null;
  notifiedAt: number | null;
  score: number | null;
  /** A decision letter is staged for the current decision_version. */
  letterStaged: boolean;
  decidedNotTold: boolean;
  startsAt: number | null;
  roomName: string | null;
};

export type Pile = {
  eventId: string;
  filter: PileFilter;
  search: string | null;
  rows: PileRow[];
  counts: PileCounts;
};

export type ProposalReview = {
  id: string;
  reviewerPersonId: string;
  reviewerName: string;
  round: number;
  scores: Record<string, number>;
  note: string | null;
  submittedAt: number | null;
};

export type ReviewAggregate = { key: string; average: number; count: number };

export type ProposalParticipant = {
  personId: string;
  name: string;
  email: string | null;
  jobTitle: string | null;
  organisation: string | null;
  phone: string | null;
  role: 'speaker' | 'co_speaker' | 'co_author' | 'panelist' | 'moderator';
  position: number;
  isSubmitter: boolean;
};

export type ProposalTask = {
  id: string;
  personId: string;
  kind: string;
  templateKey: string | null;
  title: string;
  instructions: string | null;
  dueOn: string | null;
  completedAt: number | null;
  cancelledAt: number | null;
  cancelReason: string | null;
  response: string | null;
};

export type ProposalMessage = {
  id: string;
  personId: string;
  personName: string;
  kind: string;
  decisionVersion: number | null;
  subject: string;
  body: string;
  createdAt: number;
  deliveredAt: number | null;
  emailedAt: number | null;
  blockedReason: string | null;
  /** Staged means written and not yet sent. */
  staged: boolean;
};

export type ProposalDeliverableVersion = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: number;
  current: boolean;
};

export type ProposalDeliverableComment = {
  id: string;
  authorPersonId: string;
  authorName: string;
  body: string;
  createdAt: number;
};

/** CNT-04/CNT-05 — one file-request task on this proposal, whole: every
 *  version it has ever been sent (current first) and the comment thread
 *  underneath it. Grouped by task rather than left as a flat file list, so
 *  the organizer's own file view can show what a version list can only mean
 *  once it knows which request the versions belong to. */
export type ProposalDeliverable = {
  taskId: string;
  title: string;
  dueOn: string | null;
  completedAt: number | null;
  cancelledAt: number | null;
  versions: ProposalDeliverableVersion[];
  comments: ProposalDeliverableComment[];
};

export type ProposalRevision = {
  id: string;
  body: string;
  source: string;
  createdAt: number;
  /** Whose hand wrote the words this snapshot replaced — null before 0020. */
  authorName: string | null;
};

export type Proposal = {
  id: string;
  eventId: string;
  title: string;
  abstract: string | null;
  format: string;
  level: string | null;
  minutes: number;
  track: { id: string; slug: string; name: string; colour: string } | null;
  source: string;
  answers: Record<string, unknown>;
  state: SubmissionState;
  decisionVersion: number;
  createdAt: number;
  submittedAt: number | null;
  decidedAt: number | null;
  decisionNote: string | null;
  notifiedAt: number | null;
  decidedNotTold: boolean;
  letterStaged: boolean;
  cancelledAt: number | null;
  cancelNote: string | null;
  score: number | null;
  scoreNotes: string | null;
  startsAt: number | null;
  day: string | null;
  roomId: string | null;
  roomName: string | null;
  publicSlug: string | null;
  recordingUrl: string | null;
  resumeNonce: string | null;
  participation: ProposalParticipant[];
  reviews: ProposalReview[];
  /** The event's per-round scorecard defs (raw JSON), so the route can read
   *  each review against the card its own round used — the same source the
   *  results table trusts. */
  roundScorecards: string;
  reviewsSubmitted: number;
  tasks: ProposalTask[];
  messages: ProposalMessage[];
  deliverables: ProposalDeliverable[];
  revisions: ProposalRevision[];
};

export type OutboxMessage = {
  id: string;
  kind: string;
  subject: string;
  body: string;
  createdAt: number;
  decisionVersion: number | null;
  blockedReason: string | null;
  personId: string;
  recipient: string;
  hasEmail: boolean;
  submissionId: string | null;
  submissionTitle: string | null;
  /** The submission's state — what this letter is about to tell somebody. */
  submissionState: SubmissionState | null;
  /** Always true in the outbox: staged is delivered_at IS NULL. */
  staged: boolean;
};

export type OutboxGroup = { kind: string; count: number; messages: OutboxMessage[] };

export type Outbox = {
  eventId: string;
  staged: number;
  groups: OutboxGroup[];
  /** The confirm line is built from these: "Send 610 decisions? 12 maybe, 598 declined." */
  decisionsStaged: number;
  decisionsByState: { state: SubmissionState; count: number }[];
  /** Recipients with nowhere to send to — name and id, so the screen can fix them. */
  missingEmail: { personId: string; name: string }[];
};

/** 'present' | 'absent' | 'not_requested' map straight onto the file.* labels. */
export type SlidesStatus = 'present' | 'absent' | 'not_requested';

export type GreenRoomSession = {
  id: string;
  title: string;
  state: 'accepted' | 'cancelled';
  cancelled: boolean;
  startsAt: number;
  minutes: number;
  format: string;
  roomName: string | null;
  publicSlug: string | null;
  speakers: { personId: string; name: string; phone: string | null }[];
  slides: SlidesStatus;
  slidesDueOn: string | null;
};

export type GreenRoom = {
  eventId: string;
  eventName: string;
  timezone: string;
  tzLabel: string | null;
  /** The day being shown, ISO, in the event's own timezone. */
  day: string;
  /** Every day that has something placed on it, so the sheet can offer the others. */
  days: string[];
  sessions: GreenRoomSession[];
};

/* ------------------------------------------------------------------ *
 * Row shapes and helpers
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
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

/** The search, case-folded for instr(). Not LIKE: D1 refuses a bound LIKE
 *  pattern much past 50 bytes ("pattern too complex"), and a pasted title is
 *  longer than that. instr has no pattern language, so nothing to escape. */
function needleOf(search: string): string {
  return search.trim().toLowerCase();
}

// The filter names are the organizer's words (02 §6); these are the states
// behind them. 'all' excludes drafts, because a draft has not been sent and is
// therefore not yet a proposal; 'accepted' includes cancelled, because a
// cancelled talk is an accepted one that came off the program (01 inv. 2).
const FILTER_SQL: Record<PileFilter, string> = {
  all: "s.state <> 'draft'",
  undecided: "s.state = 'submitted'",
  maybe: "s.state = 'waitlisted'",
  accepted: "s.state IN ('accepted','cancelled')",
  declined: "s.state = 'rejected'",
  drafts: "s.state = 'draft'",
  withdrawn: "s.state = 'withdrawn'",
};

const SEARCH_SQL = `(instr(lower(s.title), ?) > 0 OR EXISTS (
  SELECT 1 FROM participation pa JOIN person pe ON pe.id = pa.person_id
  WHERE pa.submission_id = s.id AND instr(lower(pe.name), ?) > 0))`;

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

type AdminEventRow = {
  id: string;
  slug: string;
  name: string;
  starts_on: string;
  ends_on: string;
  timezone: string;
  tz_label: string | null;
  agenda_published: number;
  cfp_closes_at: number | null;
  decide_by: string | null;
  current_round: number;
  proposals: number;
  undecided: number;
  accepted: number;
  decided_not_told: number;
};

/** The events this principal may open, each with the counts the index shows. */
export async function adminEvents(
  db: D1Database,
  principal: Principal,
  nowMs: number = Date.now()
): Promise<AdminEvent[]> {
  const own = Object.keys(principal.eventRoles);
  if (principal.role !== 'organizer' && own.length === 0) {
    throw new ScopeError('There is nothing backstage for you yet.');
  }
  const scoped =
    principal.role === 'organizer' ? '' : `WHERE e.id IN (${own.map(() => '?').join(',')})`;

  const res = await db
    .prepare(
      `SELECT e.id, e.slug, e.name, e.starts_on, e.ends_on, e.timezone, e.tz_label,
              e.agenda_published, e.cfp_closes_at, e.decide_by, e.current_round,
              COUNT(CASE WHEN s.state <> 'draft' THEN 1 END) AS proposals,
              COUNT(CASE WHEN s.state = 'submitted' THEN 1 END) AS undecided,
              COUNT(CASE WHEN s.state IN ('accepted','cancelled') THEN 1 END) AS accepted,
              COUNT(CASE WHEN ${DECIDED_NOT_TOLD_SQL} THEN 1 END) AS decided_not_told
       FROM event e
       LEFT JOIN submission s ON s.event_id = e.id
       ${scoped}
       GROUP BY e.id
       ORDER BY e.starts_on DESC, e.name`
    )
    .bind(...(principal.role === 'organizer' ? [] : own))
    .all<AdminEventRow>();

  return res.results.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    timezone: r.timezone,
    tzLabel: r.tz_label,
    lifecycle: lifecycleOf(r.ends_on, r.cfp_closes_at, r.timezone, nowMs),
    agendaPublished: r.agenda_published === 1,
    cfpClosesAt: r.cfp_closes_at,
    decideBy: r.decide_by,
    currentRound: r.current_round,
    standing: principal.role === 'organizer' ? 'organizer' : (principal.eventRoles[r.id] ?? 'viewer'),
    counts: {
      proposals: r.proposals,
      undecided: r.undecided,
      accepted: r.accepted,
      decidedNotTold: r.decided_not_told,
    },
  }));
}

type PileSqlRow = {
  id: string;
  title: string;
  speaker_name: string | null;
  speaker_count: number;
  format: string;
  requested_min: number;
  level: string | null;
  state: SubmissionState;
  submitted_at: number | null;
  decided_at: number | null;
  notified_at: number | null;
  score: number | null;
  letter_staged: number;
  decided_not_told: number;
  starts_at: number | null;
  room_name: string | null;
  track_slug: string | null;
  track_name: string | null;
  track_colour: string | null;
};

type PileCountRow = {
  all_count: number;
  undecided: number;
  maybe: number;
  accepted: number;
  declined: number;
  drafts: number;
  withdrawn: number;
  decided_not_told: number;
};

/**
 * The proposals list. Rows for the chosen filter, and every filter's count in
 * one pass over the same predicate — so the tabs and the list can never
 * disagree, including while a search is on ("the filters are counts, and the
 * counts are true").
 */
export async function pile(
  db: D1Database,
  principal: Principal,
  eventId: string,
  filter: PileFilter = 'all',
  opts: { search?: string; limit?: number } = {}
): Promise<Pile> {
  requireScope(principal, eventId, READ_ROLES);

  const search = opts.search?.trim() ? opts.search.trim() : null;
  const pattern = search ? needleOf(search) : null;
  const searchClause = pattern ? ` AND ${SEARCH_SQL}` : '';
  const searchBindings = pattern ? [pattern, pattern] : [];
  const limitClause = opts.limit && opts.limit > 0 ? ` LIMIT ${Math.floor(opts.limit)}` : '';

  const [rowRes, countRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT s.id, s.title, s.format, s.requested_min, s.level, s.state, s.submitted_at,
                s.decided_at, s.notified_at, s.score, s.starts_at,
                CASE WHEN ${DECIDED_NOT_TOLD_SQL} THEN 1 ELSE 0 END AS decided_not_told,
                ${LETTER_STAGED_SQL} AS letter_staged,
                (SELECT pe.name FROM participation pa JOIN person pe ON pe.id = pa.person_id
                 WHERE pa.submission_id = s.id
                 ORDER BY pa.is_submitter DESC, pa.position, pe.name LIMIT 1) AS speaker_name,
                (SELECT COUNT(*) FROM participation pa WHERE pa.submission_id = s.id) AS speaker_count,
                r.name AS room_name,
                t.slug AS track_slug, t.name AS track_name, t.colour AS track_colour
         FROM submission s
         LEFT JOIN room r ON r.id = s.room_id
         LEFT JOIN track t ON t.id = s.track_id
         WHERE s.event_id = ? AND ${FILTER_SQL[filter]}${searchClause}
         ORDER BY s.submitted_at IS NULL, s.submitted_at DESC, s.created_at DESC, s.title${limitClause}`
      )
      .bind(eventId, ...searchBindings),
    db
      .prepare(
        `SELECT
           COUNT(CASE WHEN ${FILTER_SQL.all} THEN 1 END) AS all_count,
           COUNT(CASE WHEN ${FILTER_SQL.undecided} THEN 1 END) AS undecided,
           COUNT(CASE WHEN ${FILTER_SQL.maybe} THEN 1 END) AS maybe,
           COUNT(CASE WHEN ${FILTER_SQL.accepted} THEN 1 END) AS accepted,
           COUNT(CASE WHEN ${FILTER_SQL.declined} THEN 1 END) AS declined,
           COUNT(CASE WHEN ${FILTER_SQL.drafts} THEN 1 END) AS drafts,
           COUNT(CASE WHEN ${FILTER_SQL.withdrawn} THEN 1 END) AS withdrawn,
           COUNT(CASE WHEN ${DECIDED_NOT_TOLD_SQL} THEN 1 END) AS decided_not_told
         FROM submission s
         WHERE s.event_id = ?${searchClause}`
      )
      .bind(eventId, ...searchBindings),
  ]);

  const c = rowsOf<PileCountRow>(countRes)[0];
  return {
    eventId,
    filter,
    search,
    rows: rowsOf<PileSqlRow>(rowRes).map((r) => ({
      id: r.id,
      title: r.title,
      speaker: r.speaker_name,
      speakerCount: r.speaker_count,
      track:
        r.track_slug && r.track_name && r.track_colour
          ? { slug: r.track_slug, name: r.track_name, colour: r.track_colour }
          : null,
      format: r.format,
      minutes: r.requested_min,
      level: r.level,
      state: r.state,
      submittedAt: r.submitted_at,
      decidedAt: r.decided_at,
      notifiedAt: r.notified_at,
      score: r.score,
      letterStaged: r.letter_staged === 1,
      decidedNotTold: r.decided_not_told === 1,
      startsAt: r.starts_at,
      roomName: r.room_name,
    })),
    counts: {
      all: c?.all_count ?? 0,
      undecided: c?.undecided ?? 0,
      maybe: c?.maybe ?? 0,
      accepted: c?.accepted ?? 0,
      declined: c?.declined ?? 0,
      drafts: c?.drafts ?? 0,
      withdrawn: c?.withdrawn ?? 0,
      decidedNotTold: c?.decided_not_told ?? 0,
    },
  };
}

type ProposalSqlRow = {
  id: string;
  event_id: string;
  title: string;
  abstract: string | null;
  format: string;
  level: string | null;
  requested_min: number;
  extra: string;
  source: string;
  state: SubmissionState;
  decision_version: number;
  created_at: number;
  submitted_at: number | null;
  decided_at: number | null;
  decision_note: string | null;
  notified_at: number | null;
  decided_not_told: number;
  letter_staged: number;
  cancelled_at: number | null;
  cancel_note: string | null;
  score: number | null;
  score_notes: string | null;
  starts_at: number | null;
  room_id: string | null;
  room_name: string | null;
  public_slug: string | null;
  recording_url: string | null;
  resume_nonce: string | null;
  timezone: string;
  round_scorecards: string;
  track_id: string | null;
  track_slug: string | null;
  track_name: string | null;
  track_colour: string | null;
};

/** One proposal, whole: the committee's own view, decision facts included. */
export async function proposal(
  db: D1Database,
  principal: Principal,
  eventId: string,
  submissionId: string
): Promise<Proposal | null> {
  requireScope(principal, eventId, READ_ROLES);

  const [subRes, partRes, reviewRes, taskRes, msgRes, deliverableTaskRes, deliverableFileRes, deliverableCommentRes, revRes] = await db.batch<
    Record<string, unknown>
  >([
    db
      .prepare(
        `SELECT s.id, s.event_id, s.title, s.abstract, s.format, s.level, s.requested_min, s.extra,
                s.source, s.state, s.decision_version, s.created_at, s.submitted_at, s.decided_at,
                s.decision_note, s.notified_at, s.cancelled_at, s.cancel_note, s.score,
                s.score_notes, s.starts_at, s.room_id, s.public_slug, s.recording_url,
                s.resume_nonce, s.track_id,
                CASE WHEN ${DECIDED_NOT_TOLD_SQL} THEN 1 ELSE 0 END AS decided_not_told,
                ${LETTER_STAGED_SQL} AS letter_staged,
                e.timezone, e.round_scorecards,
                r.name AS room_name,
                t.slug AS track_slug, t.name AS track_name, t.colour AS track_colour
         FROM submission s
         JOIN event e ON e.id = s.event_id
         LEFT JOIN room r ON r.id = s.room_id
         LEFT JOIN track t ON t.id = s.track_id
         WHERE s.id = ? AND s.event_id = ?`
      )
      .bind(submissionId, eventId),
    db
      .prepare(
        `SELECT pe.id AS person_id, pe.name, pe.email, pe.job_title, pe.organisation, pe.phone,
                pa.role, pa.position, pa.is_submitter
         FROM participation pa
         JOIN person pe ON pe.id = pa.person_id
         WHERE pa.submission_id = ?
         ORDER BY pa.is_submitter DESC, pa.position, pe.name`
      )
      .bind(submissionId),
    db
      .prepare(
        `SELECT rv.id, rv.reviewer_person_id, pe.name AS reviewer_name, rv.round, rv.scores,
                rv.note, rv.submitted_at
         FROM review rv
         JOIN person pe ON pe.id = rv.reviewer_person_id
         WHERE rv.submission_id = ?
         ORDER BY rv.round, pe.name`
      )
      .bind(submissionId),
    // The committee's average is not aggregated in SQL: a naive AVG over the
    // scores JSON casts a text or select line to zero and drags the number
    // down (a chair once read 1.5 where the results table read 3.2). The read
    // is rebuilt in the route from these submitted reviews and the round's own
    // scorecard, through the one weightedAverage every other screen trusts —
    // scale lines only, weighted, words never averaged.
    db
      .prepare(
        `SELECT id, person_id, kind, template_key, title, instructions, due_on, completed_at,
                cancelled_at, cancel_reason, response
         FROM task WHERE submission_id = ?
         ORDER BY cancelled_at IS NOT NULL, due_on IS NULL, due_on, title`
      )
      .bind(submissionId),
    db
      .prepare(
        `SELECT m.id, m.person_id, pe.name AS person_name, m.kind, m.decision_version, m.subject,
                m.body, m.created_at, m.delivered_at, m.emailed_at, m.blocked_reason
         FROM message m JOIN person pe ON pe.id = m.person_id
         WHERE m.submission_id = ?
         ORDER BY m.created_at DESC, m.id`
      )
      .bind(submissionId),
    // CNT-04/CNT-05 — the deliverable requests on this proposal (whatever the
    // organizer has ever asked for here), each with its own versions and its
    // own thread. Cancelled requests are not filtered out: a request that was
    // withdrawn can still carry a comment worth reading.
    db
      .prepare(
        `SELECT id, title, due_on, completed_at, cancelled_at
           FROM task WHERE submission_id = ? AND kind = 'file_request'
          ORDER BY cancelled_at IS NOT NULL, completed_at IS NOT NULL, due_on IS NULL, due_on, title`
      )
      .bind(submissionId),
    // Every version ever sent against one of those requests. The join
    // reconstructs the key a version was written under (workflows/files.ts's
    // 'slides/{taskId}/{fileId}') rather than parsing it back out of a string,
    // so a task and its files can never silently drift apart.
    db
      .prepare(
        `SELECT f.id, f.filename, f.content_type, f.size_bytes, f.uploaded_at, f.replaced_at, tk.id AS task_id
           FROM file f
           JOIN task tk ON tk.submission_id = ?1 AND tk.kind = 'file_request'
                        AND f.r2_key = 'slides/' || tk.id || '/' || f.id
          WHERE f.owner_kind = 'submission' AND f.owner_id = ?1
          ORDER BY tk.id, f.replaced_at IS NOT NULL, f.uploaded_at DESC`
      )
      .bind(submissionId),
    db
      .prepare(
        `SELECT fc.id, fc.task_id, fc.author_person_id, pe.name AS author_name, fc.body, fc.created_at
           FROM file_comment fc
           JOIN task tk ON tk.id = fc.task_id AND tk.submission_id = ?
           JOIN person pe ON pe.id = fc.author_person_id
          ORDER BY fc.task_id, fc.created_at`
      )
      .bind(submissionId),
    db
      .prepare(
        `SELECT r.id, r.body, r.source, r.created_at, r.author_id, pe.name AS author_name
         FROM revision r LEFT JOIN person pe ON pe.id = r.author_id
         WHERE r.owner_kind = 'submission' AND r.owner_id = ?
         ORDER BY r.created_at DESC`
      )
      .bind(submissionId),
  ]);

  const s = rowsOf<ProposalSqlRow>(subRes)[0];
  if (!s) return null;

  const reviews = rowsOf<{
    id: string;
    reviewer_person_id: string;
    reviewer_name: string;
    round: number;
    scores: string;
    note: string | null;
    submitted_at: number | null;
  }>(reviewRes).map((r) => ({
    id: r.id,
    reviewerPersonId: r.reviewer_person_id,
    reviewerName: r.reviewer_name,
    round: r.round,
    scores: asScores(r.scores),
    note: r.note,
    submittedAt: r.submitted_at,
  }));

  return {
    id: s.id,
    eventId: s.event_id,
    title: s.title,
    abstract: s.abstract,
    format: s.format,
    level: s.level,
    minutes: s.requested_min,
    track:
      s.track_id && s.track_slug && s.track_name && s.track_colour
        ? { id: s.track_id, slug: s.track_slug, name: s.track_name, colour: s.track_colour }
        : null,
    source: s.source,
    answers: asObject(s.extra),
    state: s.state,
    decisionVersion: s.decision_version,
    createdAt: s.created_at,
    submittedAt: s.submitted_at,
    decidedAt: s.decided_at,
    decisionNote: s.decision_note,
    notifiedAt: s.notified_at,
    decidedNotTold: s.decided_not_told === 1,
    letterStaged: s.letter_staged === 1,
    cancelledAt: s.cancelled_at,
    cancelNote: s.cancel_note,
    score: s.score,
    scoreNotes: s.score_notes,
    startsAt: s.starts_at,
    day: s.starts_at === null ? null : eventDayKey(s.starts_at, s.timezone),
    roomId: s.room_id,
    roomName: s.room_name,
    publicSlug: s.public_slug,
    recordingUrl: s.recording_url,
    resumeNonce: s.resume_nonce,
    participation: rowsOf<{
      person_id: string;
      name: string;
      email: string | null;
      job_title: string | null;
      organisation: string | null;
      phone: string | null;
      role: 'speaker' | 'co_speaker' | 'co_author' | 'panelist' | 'moderator';
      position: number;
      is_submitter: number;
    }>(partRes).map((p) => ({
      personId: p.person_id,
      name: p.name,
      email: p.email,
      jobTitle: p.job_title,
      organisation: p.organisation,
      phone: p.phone,
      role: p.role,
      position: p.position,
      isSubmitter: p.is_submitter === 1,
    })),
    reviews,
    roundScorecards: s.round_scorecards,
    reviewsSubmitted: reviews.filter((r) => r.submittedAt !== null).length,
    tasks: rowsOf<{
      id: string;
      person_id: string;
      kind: string;
      template_key: string | null;
      title: string;
      instructions: string | null;
      due_on: string | null;
      completed_at: number | null;
      cancelled_at: number | null;
      cancel_reason: string | null;
      response: string | null;
    }>(taskRes).map((t) => ({
      id: t.id,
      personId: t.person_id,
      kind: t.kind,
      templateKey: t.template_key,
      title: t.title,
      instructions: t.instructions,
      dueOn: t.due_on,
      completedAt: t.completed_at,
      cancelledAt: t.cancelled_at,
      cancelReason: t.cancel_reason,
      response: t.response,
    })),
    messages: rowsOf<{
      id: string;
      person_id: string;
      person_name: string;
      kind: string;
      decision_version: number | null;
      subject: string;
      body: string;
      created_at: number;
      delivered_at: number | null;
      emailed_at: number | null;
      blocked_reason: string | null;
    }>(msgRes).map((m) => ({
      id: m.id,
      personId: m.person_id,
      personName: m.person_name,
      kind: m.kind,
      decisionVersion: m.decision_version,
      subject: m.subject,
      body: m.body,
      createdAt: m.created_at,
      deliveredAt: m.delivered_at,
      emailedAt: m.emailed_at,
      blockedReason: m.blocked_reason,
      staged: m.delivered_at === null,
    })),
    deliverables: (() => {
      const versionsByTask = new Map<string, ProposalDeliverableVersion[]>();
      for (const f of rowsOf<{
        id: string;
        filename: string;
        content_type: string;
        size_bytes: number;
        uploaded_at: number;
        replaced_at: number | null;
        task_id: string;
      }>(deliverableFileRes)) {
        const list = versionsByTask.get(f.task_id) ?? [];
        list.push({
          id: f.id,
          filename: f.filename,
          contentType: f.content_type,
          sizeBytes: f.size_bytes,
          uploadedAt: f.uploaded_at,
          current: f.replaced_at === null,
        });
        versionsByTask.set(f.task_id, list);
      }
      const commentsByTask = new Map<string, ProposalDeliverableComment[]>();
      for (const c of rowsOf<{
        id: string;
        task_id: string;
        author_person_id: string;
        author_name: string;
        body: string;
        created_at: number;
      }>(deliverableCommentRes)) {
        const list = commentsByTask.get(c.task_id) ?? [];
        list.push({
          id: c.id,
          authorPersonId: c.author_person_id,
          authorName: c.author_name,
          body: c.body,
          createdAt: c.created_at,
        });
        commentsByTask.set(c.task_id, list);
      }
      return rowsOf<{
        id: string;
        title: string;
        due_on: string | null;
        completed_at: number | null;
        cancelled_at: number | null;
      }>(deliverableTaskRes).map((t) => ({
        taskId: t.id,
        title: t.title,
        dueOn: t.due_on,
        completedAt: t.completed_at,
        cancelledAt: t.cancelled_at,
        versions: versionsByTask.get(t.id) ?? [],
        comments: commentsByTask.get(t.id) ?? [],
      }));
    })(),
    revisions: rowsOf<{
      id: string; body: string; source: string; created_at: number; author_name: string | null;
    }>(revRes).map(
      (r) => ({ id: r.id, body: r.body, source: r.source, createdAt: r.created_at, authorName: r.author_name })
    ),
  };
}

/** Everything written and not yet sent, grouped by what kind of letter it is. */
export async function outbox(
  db: D1Database,
  principal: Principal,
  eventId: string
): Promise<Outbox> {
  requireScope(principal, eventId, LETTER_ROLES);

  const [msgRes, stateRes, missingRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT m.id, m.kind, m.subject, m.body, m.created_at, m.decision_version, m.blocked_reason,
                m.person_id, pe.name AS recipient, pe.email,
                m.submission_id, s.title AS submission_title, s.state AS submission_state
         FROM message m
         JOIN person pe ON pe.id = m.person_id
         LEFT JOIN submission s ON s.id = m.submission_id
         WHERE m.event_id = ? AND m.delivered_at IS NULL
         ORDER BY m.kind, m.created_at, m.id`
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT s.state, COUNT(*) AS n
         FROM message m JOIN submission s ON s.id = m.submission_id
         WHERE m.event_id = ? AND m.delivered_at IS NULL AND m.kind = 'decision'
         GROUP BY s.state
         ORDER BY n DESC`
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT DISTINCT pe.id AS person_id, pe.name
         FROM message m JOIN person pe ON pe.id = m.person_id
         WHERE m.event_id = ? AND m.delivered_at IS NULL
           AND (pe.email IS NULL OR trim(pe.email) = '')
         ORDER BY pe.name`
      )
      .bind(eventId),
  ]);

  const groups: OutboxGroup[] = [];
  let group: OutboxGroup | undefined;
  let staged = 0;
  for (const m of rowsOf<{
    id: string;
    kind: string;
    subject: string;
    body: string;
    created_at: number;
    decision_version: number | null;
    blocked_reason: string | null;
    person_id: string;
    recipient: string;
    email: string | null;
    submission_id: string | null;
    submission_title: string | null;
    submission_state: SubmissionState | null;
  }>(msgRes)) {
    if (!group || group.kind !== m.kind) {
      group = { kind: m.kind, count: 0, messages: [] };
      groups.push(group);
    }
    group.count += 1;
    staged += 1;
    group.messages.push({
      id: m.id,
      kind: m.kind,
      subject: m.subject,
      body: m.body,
      createdAt: m.created_at,
      decisionVersion: m.decision_version,
      blockedReason: m.blocked_reason,
      personId: m.person_id,
      recipient: m.recipient,
      hasEmail: !!m.email && m.email.trim() !== '',
      submissionId: m.submission_id,
      submissionTitle: m.submission_title,
      submissionState: m.submission_state,
      staged: true,
    });
  }

  const decisionsByState = rowsOf<{ state: SubmissionState; n: number }>(stateRes).map((r) => ({
    state: r.state,
    count: r.n,
  }));

  return {
    eventId,
    staged,
    groups,
    decisionsStaged: decisionsByState.reduce((sum, r) => sum + r.count, 0),
    decisionsByState,
    missingEmail: rowsOf<{ person_id: string; name: string }>(missingRes).map((p) => ({
      personId: p.person_id,
      name: p.name,
    })),
  };
}

/**
 * The green room sheet — the run of show for one day, on a volunteer's phone.
 *
 * TOKEN-SCOPED, deliberately: this is mounted behind event.green_room_nonce and
 * takes no Principal, so a runner never holds anybody's sign-in (V-14 carve-out).
 * It ignores agenda_published, because the crew needs the day before the public
 * does; it shows phone numbers, which is exactly why the token is revocable.
 *
 * `day` defaults to today in the event's own timezone, falling back to the first
 * day that has anything placed on it.
 */
export async function greenRoom(
  db: D1Database,
  eventId: string,
  day?: string,
  nowMs: number = Date.now()
): Promise<GreenRoom | null> {
  const [eventRes, sessionRes, speakerRes, taskRes] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT id, name, timezone, tz_label FROM event WHERE id = ?').bind(eventId),
    db
      .prepare(
        `SELECT s.id, s.title, s.state, s.starts_at, s.requested_min, s.format, s.public_slug,
                r.name AS room_name, r.position AS room_position
         FROM submission s
         LEFT JOIN room r ON r.id = s.room_id
         WHERE s.event_id = ? AND s.starts_at IS NOT NULL
           AND s.state IN ('accepted','cancelled')
         ORDER BY s.starts_at, r.position, r.name, s.title`
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT pa.submission_id, pe.id AS person_id, pe.name, pe.phone
         FROM participation pa
         JOIN person pe ON pe.id = pa.person_id
         JOIN submission s ON s.id = pa.submission_id
         WHERE s.event_id = ? AND s.starts_at IS NOT NULL
           AND s.state IN ('accepted','cancelled')
         ORDER BY pa.submission_id, pa.position, pe.name`
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT t.submission_id, t.completed_at, t.due_on
         FROM task t
         JOIN submission s ON s.id = t.submission_id
         WHERE t.event_id = ? AND t.kind = 'file_request' AND t.cancelled_at IS NULL
           AND s.starts_at IS NOT NULL
         ORDER BY t.completed_at IS NOT NULL, t.due_on`
      )
      .bind(eventId),
  ]);

  const ev = rowsOf<{ id: string; name: string; timezone: string; tz_label: string | null }>(
    eventRes
  )[0];
  if (!ev) return null;

  const speakers = new Map<string, { personId: string; name: string; phone: string | null }[]>();
  for (const s of rowsOf<{
    submission_id: string;
    person_id: string;
    name: string;
    phone: string | null;
  }>(speakerRes)) {
    const list = speakers.get(s.submission_id) ?? [];
    list.push({ personId: s.person_id, name: s.name, phone: s.phone });
    speakers.set(s.submission_id, list);
  }

  // First row per submission wins: outstanding before completed (the ORDER BY),
  // so a talk with anything still owed reads as still owed.
  const slides = new Map<string, { completed: boolean; dueOn: string | null }>();
  for (const t of rowsOf<{
    submission_id: string;
    completed_at: number | null;
    due_on: string | null;
  }>(taskRes)) {
    if (slides.has(t.submission_id)) continue;
    slides.set(t.submission_id, { completed: t.completed_at !== null, dueOn: t.due_on });
  }

  const rows = rowsOf<{
    id: string;
    title: string;
    state: 'accepted' | 'cancelled';
    starts_at: number;
    requested_min: number;
    format: string;
    public_slug: string | null;
    room_name: string | null;
  }>(sessionRes);

  const days: string[] = [];
  for (const r of rows) {
    const key = eventDayKey(r.starts_at, ev.timezone);
    if (days[days.length - 1] !== key && !days.includes(key)) days.push(key);
  }
  const today = eventDayKey(nowMs, ev.timezone);
  const chosen = day ?? (days.includes(today) ? today : (days[0] ?? today));

  const sessions: GreenRoomSession[] = rows
    .filter((r) => eventDayKey(r.starts_at, ev.timezone) === chosen)
    .map((r) => {
      const task = slides.get(r.id);
      return {
        id: r.id,
        title: r.title,
        state: r.state,
        cancelled: r.state === 'cancelled',
        startsAt: r.starts_at,
        minutes: r.requested_min,
        format: r.format,
        roomName: r.room_name,
        publicSlug: r.public_slug,
        speakers: speakers.get(r.id) ?? [],
        slides: task ? (task.completed ? 'present' : 'absent') : 'not_requested',
        slidesDueOn: task?.dueOn ?? null,
      };
    });

  return {
    eventId: ev.id,
    eventName: ev.name,
    timezone: ev.timezone,
    tzLabel: ev.tz_label,
    day: chosen,
    days,
    sessions,
  };
}
