// The speaker CRM read layer (07) — the organization's own memory of every
// speaker and prospect it has ever dealt with, one level above any single
// event. `person` was always this: nothing about that table is scoped to a
// conference. CRM reads it as the directory it already is, and adds three
// things a conference-scoped screen never needed: a note, a tag or a custom
// field, and a sourcing card that tracks somebody before they have a
// proposal at all.
//
// Read-only. No writer touches this file's tables from here — see
// workflows/crm.ts for every mutation, in the same discipline
// queries/people.ts and workflows/tasks.ts already keep between them.
//
// Reachable at organization level only: an event editor or approver reads
// their own event's people through queries/people.ts, exactly as before.
// Seeing speakers who have never touched THEIR conference is a wider fact
// than any one event's role was ever meant to carry, so requireOrg below
// asks for the install-wide standing OR ownership of at least one event —
// an event's owner is its organizer in every sense that matters here.
import { ScopeError } from './admin';
import type { SubmissionState } from './admin';
import type { Principal } from '../workflows/account';

/* ------------------------------------------------------------------ *
 * Scope
 * ------------------------------------------------------------------ */

/** Install-wide organizers hold this by default; anyone who owns at least
 *  one event holds it too — an event's owner is its organizer in every
 *  sense that matters here, even before an install-wide standing is ever
 *  granted them. Approver, editor and viewer stop at their own event's
 *  People page (queries/people.ts) same as always; only 'owner' widens
 *  into the cross-event database. */
export function requireOrg(principal: Principal): void {
  if (principal.role === 'organizer') return;
  if (Object.values(principal.eventRoles).includes('owner')) return;
  throw new ScopeError('The speaker database is the organizers’ to read.');
}

/* ------------------------------------------------------------------ *
 * Derived status — computed, never stored (07's own status ladder).
 *
 * A stored "status" column drifts from the truth the moment somebody forgets
 * to update it after a real decision. This one cannot drift: it is read off
 * the same facts the rest of the product already keeps — a roster entry, a
 * real proposal, a decision, and whether anything is still owed — the same
 * discipline DECIDED_NOT_TOLD_SQL keeps for a proposal's own state.
 * ------------------------------------------------------------------ */

export type DerivedStatus = 'prospect' | 'invited' | 'proposed' | 'confirmed' | 'onboarded';

export function deriveStatus(f: {
  hasRoster: boolean;
  hasSubmission: boolean;
  hasAccepted: boolean;
  hasAnyTask: boolean;
  hasOpenTask: boolean;
}): DerivedStatus {
  if (f.hasAccepted) return f.hasAnyTask && !f.hasOpenTask ? 'onboarded' : 'confirmed';
  if (f.hasSubmission) return 'proposed';
  if (f.hasRoster) return 'invited';
  return 'prospect';
}

/* ------------------------------------------------------------------ *
 * Row shapes and helpers
 * ------------------------------------------------------------------ */

function rowsOf<T>(res: D1Result<Record<string, unknown>> | undefined): T[] {
  return (res?.results ?? []) as unknown as T[];
}

const needleOf = (s: string): string => s.trim().toLowerCase();

/** IN (?, ?, ...) — the same pattern adminEvents already binds a variable
 *  list with, kept local because every caller here needs it once. */
function inClause(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

// D1 caps bound parameters per statement, so an org-wide directory (a thousand
// people) cannot pass every id into one IN clause. Ninety at a time stays well
// under the cap and keeps the read to a handful of batched round trips.
const ID_CHUNK = 90;
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* ------------------------------------------------------------------ *
 * The directory — CRM-01, CRM-02
 * ------------------------------------------------------------------ */

export type ContactRow = {
  personId: string;
  name: string;
  email: string | null;
  jobTitle: string | null;
  organisation: string | null;
  speakerType: 'internal' | 'external' | null;
  tags: string[];
  status: DerivedStatus;
  eventCount: number;
};

export type CrmDirectory = {
  search: string | null;
  company: string | null;
  jobTitle: string | null;
  tag: string | null;
  rows: ContactRow[];
  /** True when the directory opened capped and there are more contacts than
   *  the page shows — the banner offers the full list as the alternate. */
  truncated: boolean;
  /** Every contact in the org, ignoring search and filters — the dashboard's
   *  own count derives from this and no other query, so the two can never
   *  disagree (the same "one predicate, one pass" rule pile()'s counts keep). */
  totalAll: number;
};

export type DirectoryOpts = {
  search?: string;
  company?: string;
  jobTitle?: string;
  tag?: string;
  /** Show the whole directory rather than the first page of it. The full list
   *  is the alternate view, never the default — an unfiltered directory of
   *  hundreds is unreadable, so it opens capped and this asks for all of it. */
  all?: boolean;
};

/** The default cap on an unfiltered, un-"all" directory. A search or a filter
 *  removes the cap (the result set is already bounded by the query). */
export const DIRECTORY_PAGE = 50;

/** Parse a saved segment's stored query string back into the same shape a
 *  fresh directory search takes — so a dynamic segment is nothing more than
 *  this function, run again. */
export function directoryOptsFromQuery(qs: string): DirectoryOpts {
  const p = new URLSearchParams(qs);
  const get = (k: string): string | undefined => {
    const v = p.get(k);
    return v && v.trim() !== '' ? v : undefined;
  };
  return { search: get('q'), company: get('company'), jobTitle: get('title'), tag: get('tag') };
}

export function directoryQueryString(opts: DirectoryOpts): string {
  const p = new URLSearchParams();
  if (opts.search) p.set('q', opts.search);
  if (opts.company) p.set('company', opts.company);
  if (opts.jobTitle) p.set('title', opts.jobTitle);
  if (opts.tag) p.set('tag', opts.tag);
  return p.toString();
}

type ContactSqlRow = {
  id: string;
  name: string;
  email: string | null;
  job_title: string | null;
  organisation: string | null;
  speaker_type: 'internal' | 'external' | null;
};

async function statusFactsFor(
  db: D1Database,
  ids: string[]
): Promise<
  Map<string, { hasRoster: boolean; hasSubmission: boolean; hasAccepted: boolean; hasAnyTask: boolean; hasOpenTask: boolean; events: Set<string> }>
> {
  const facts = new Map<
    string,
    { hasRoster: boolean; hasSubmission: boolean; hasAccepted: boolean; hasAnyTask: boolean; hasOpenTask: boolean; events: Set<string> }
  >();
  if (ids.length === 0) return facts;
  const get = (id: string) => {
    let f = facts.get(id);
    if (!f) {
      f = { hasRoster: false, hasSubmission: false, hasAccepted: false, hasAnyTask: false, hasOpenTask: false, events: new Set() };
      facts.set(id, f);
    }
    return f;
  };

  for (const part of chunk(ids, ID_CHUNK)) {
    const ph = inClause(part.length);
    const [rosterRes, subRes, taskRes] = await db.batch<Record<string, unknown>>([
      db.prepare(`SELECT person_id, event_id FROM roster_entry WHERE person_id IN (${ph})`).bind(...part),
      db
        .prepare(
          `SELECT pa.person_id, s.event_id, s.state
           FROM participation pa JOIN submission s ON s.id = pa.submission_id
           WHERE pa.person_id IN (${ph}) AND s.state <> 'draft'`
        )
        .bind(...part),
      db
        .prepare(`SELECT person_id, completed_at, cancelled_at FROM task WHERE person_id IN (${ph})`)
        .bind(...part),
    ]);

    for (const r of rowsOf<{ person_id: string; event_id: string }>(rosterRes)) {
      const f = get(r.person_id);
      f.hasRoster = true;
      f.events.add(r.event_id);
    }
    for (const r of rowsOf<{ person_id: string; event_id: string; state: SubmissionState }>(subRes)) {
      const f = get(r.person_id);
      f.hasSubmission = true;
      f.events.add(r.event_id);
      if (r.state === 'accepted' || r.state === 'cancelled') f.hasAccepted = true;
    }
    for (const r of rowsOf<{ person_id: string; completed_at: number | null; cancelled_at: number | null }>(taskRes)) {
      const f = get(r.person_id);
      f.hasAnyTask = true;
      if (r.completed_at === null && r.cancelled_at === null) f.hasOpenTask = true;
    }
  }
  return facts;
}

async function tagsFor(db: D1Database, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  for (const part of chunk(ids, ID_CHUNK)) {
    const res = await db
      .prepare(`SELECT person_id, tag FROM crm_tag WHERE person_id IN (${inClause(part.length)}) ORDER BY tag`)
      .bind(...part)
      .all<{ person_id: string; tag: string }>();
    for (const r of res.results) {
      const list = out.get(r.person_id) ?? [];
      list.push(r.tag);
      out.set(r.person_id, list);
    }
  }
  return out;
}

/**
 * The org-wide directory: every contact who is not an internal account and
 * not folded into another record by a merge, narrowed by a free-text search
 * (name, email, organisation — the same three fields queries/people.ts
 * searches) and up to three attribute filters, all AND-combined.
 */
export async function crmDirectory(
  db: D1Database,
  principal: Principal,
  opts: DirectoryOpts = {}
): Promise<CrmDirectory> {
  requireOrg(principal);

  const search = opts.search?.trim() || null;
  const company = opts.company?.trim() || null;
  const jobTitle = opts.jobTitle?.trim() || null;
  const tag = opts.tag?.trim() || null;

  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (search) {
    clauses.push('(instr(lower(pe.name), ?) > 0 OR instr(lower(pe.email), ?) > 0 OR instr(lower(pe.organisation), ?) > 0)');
    const needle = needleOf(search);
    bindings.push(needle, needle, needle);
  }
  if (company) {
    clauses.push('instr(lower(pe.organisation), ?) > 0');
    bindings.push(needleOf(company));
  }
  if (jobTitle) {
    clauses.push('instr(lower(pe.job_title), ?) > 0');
    bindings.push(needleOf(jobTitle));
  }
  if (tag) {
    clauses.push('EXISTS (SELECT 1 FROM crm_tag ct WHERE ct.person_id = pe.id AND ct.tag = ?)');
    bindings.push(tag);
  }
  const where = clauses.length ? ` AND ${clauses.join(' AND ')}` : '';

  // A filtered result is already bounded, so it is shown whole. An unfiltered
  // directory is capped unless the reader asked for all of it — fetch one more
  // than the cap so "there is more" can be told from "that is everyone".
  const filtered = clauses.length > 0;
  const capped = !filtered && !opts.all;
  const limitClause = capped ? ` LIMIT ${DIRECTORY_PAGE + 1}` : '';

  const [rowRes, totalRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT pe.id, pe.name, pe.email, pe.job_title, pe.organisation, pe.speaker_type
         FROM person pe
         WHERE pe.internal_role IS NULL AND pe.merged_into_id IS NULL${where}
         ORDER BY pe.name${limitClause}`
      )
      .bind(...bindings),
    db.prepare(`SELECT COUNT(*) AS n FROM person WHERE internal_role IS NULL AND merged_into_id IS NULL`),
  ]);

  const fetched = rowsOf<ContactSqlRow>(rowRes);
  const truncated = capped && fetched.length > DIRECTORY_PAGE;
  const contacts = truncated ? fetched.slice(0, DIRECTORY_PAGE) : fetched;
  const ids = contacts.map((c) => c.id);
  const [facts, tags] = await Promise.all([statusFactsFor(db, ids), tagsFor(db, ids)]);

  const rows: ContactRow[] = contacts.map((c) => {
    const f = facts.get(c.id);
    return {
      personId: c.id,
      name: c.name,
      email: c.email,
      jobTitle: c.job_title,
      organisation: c.organisation,
      speakerType: c.speaker_type,
      tags: tags.get(c.id) ?? [],
      status: deriveStatus(
        f ?? { hasRoster: false, hasSubmission: false, hasAccepted: false, hasAnyTask: false, hasOpenTask: false }
      ),
      eventCount: f ? f.events.size : 0,
    };
  });

  const total = rowsOf<{ n: number }>(totalRes)[0]?.n ?? 0;
  return { search, company, jobTitle, tag, rows, totalAll: total, truncated };
}

/* ------------------------------------------------------------------ *
 * One contact — CRM-03
 * ------------------------------------------------------------------ */

export type ContactEventLink = {
  eventId: string;
  eventSlug: string;
  eventName: string;
  submissionId: string | null;
  submissionTitle: string | null;
  state: SubmissionState | null;
};

export type ContactNote = { id: string; body: string; authorName: string; createdAt: number };

export type ContactDetail = {
  personId: string;
  name: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  organisation: string | null;
  bio: string | null;
  logistics: string | null;
  speakerType: 'internal' | 'external' | null;
  tags: string[];
  status: DerivedStatus;
  events: ContactEventLink[];
  notes: ContactNote[];
  card: { id: string; stage: string } | null;
  /** Another live record with the same name, trimmed and case-folded —
   *  CRM-06's own trigger: a same-name, different-email pair is exactly what
   *  a merge exists to catch. */
  possibleDuplicates: { personId: string; name: string; email: string | null }[];
};

export async function contactDetail(
  db: D1Database,
  principal: Principal,
  personId: string
): Promise<ContactDetail | null> {
  requireOrg(principal);

  const [personRes, eventsRes, rosterEventsRes, noteRes, tagRes, cardRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT id, name, email, phone, job_title, organisation, bio, logistics, speaker_type
         FROM person WHERE id = ? AND merged_into_id IS NULL`
      )
      .bind(personId),
    db
      .prepare(
        `SELECT e.id AS event_id, e.slug AS event_slug, e.name AS event_name,
                s.id AS submission_id, s.title, s.state
         FROM participation pa
         JOIN submission s ON s.id = pa.submission_id
         JOIN event e ON e.id = s.event_id
         WHERE pa.person_id = ? AND s.state <> 'draft'
         ORDER BY e.starts_on DESC, s.title`
      )
      .bind(personId),
    db
      .prepare(
        `SELECT e.id AS event_id, e.slug AS event_slug, e.name AS event_name
         FROM roster_entry r JOIN event e ON e.id = r.event_id
         WHERE r.person_id = ?
         ORDER BY e.starts_on DESC`
      )
      .bind(personId),
    db
      .prepare(
        `SELECT n.id, n.body, n.created_at, pe.name AS author_name
         FROM crm_note n JOIN person pe ON pe.id = n.author_id
         WHERE n.owner_kind = 'person' AND n.owner_id = ?
         ORDER BY n.created_at DESC`
      )
      .bind(personId),
    db.prepare(`SELECT tag FROM crm_tag WHERE person_id = ? ORDER BY tag`).bind(personId),
    db.prepare(`SELECT id, stage FROM crm_card WHERE person_id = ?`).bind(personId),
  ]);
  const dupRes = await db
    .prepare(
      `SELECT id, name, email FROM person
       WHERE id <> ? AND merged_into_id IS NULL AND internal_role IS NULL
         AND lower(trim(name)) = (SELECT lower(trim(name)) FROM person WHERE id = ?)`
    )
    .bind(personId, personId)
    .all<{ id: string; name: string; email: string | null }>();

  const p = rowsOf<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    job_title: string | null;
    organisation: string | null;
    bio: string | null;
    logistics: string | null;
    speaker_type: 'internal' | 'external' | null;
  }>(personRes)[0];
  if (!p) return null;

  const withProposal = rowsOf<{
    event_id: string;
    event_slug: string;
    event_name: string;
    submission_id: string;
    title: string;
    state: SubmissionState;
  }>(eventsRes);
  const seenEvents = new Set(withProposal.map((r) => r.event_id));
  const rosterOnly = rowsOf<{ event_id: string; event_slug: string; event_name: string }>(rosterEventsRes).filter(
    (r) => !seenEvents.has(r.event_id)
  );

  const events: ContactEventLink[] = [
    ...withProposal.map((r) => ({
      eventId: r.event_id,
      eventSlug: r.event_slug,
      eventName: r.event_name,
      submissionId: r.submission_id,
      submissionTitle: r.title,
      state: r.state,
    })),
    ...rosterOnly.map((r) => ({
      eventId: r.event_id,
      eventSlug: r.event_slug,
      eventName: r.event_name,
      submissionId: null,
      submissionTitle: null,
      state: null,
    })),
  ];

  const facts = (await statusFactsFor(db, [personId])).get(personId) ?? {
    hasRoster: false,
    hasSubmission: false,
    hasAccepted: false,
    hasAnyTask: false,
    hasOpenTask: false,
    events: new Set<string>(),
  };

  const card = rowsOf<{ id: string; stage: string }>(cardRes)[0] ?? null;

  return {
    personId: p.id,
    name: p.name,
    email: p.email,
    phone: p.phone,
    jobTitle: p.job_title,
    organisation: p.organisation,
    bio: p.bio,
    logistics: p.logistics,
    speakerType: p.speaker_type,
    tags: rowsOf<{ tag: string }>(tagRes).map((t) => t.tag),
    status: deriveStatus(facts),
    events,
    notes: rowsOf<{ id: string; body: string; created_at: number; author_name: string }>(noteRes).map((n) => ({
      id: n.id,
      body: n.body,
      authorName: n.author_name,
      createdAt: n.created_at,
    })),
    card: card ? { id: card.id, stage: card.stage } : null,
    possibleDuplicates: dupRes.results.map((d) => ({ personId: d.id, name: d.name, email: d.email })),
  };
}

/* ------------------------------------------------------------------ *
 * Saved segments — CRM-09
 * ------------------------------------------------------------------ */

export type SegmentSummary = { id: string; name: string; kind: 'dynamic' | 'curated'; memberCount: number; createdAt: number };

export async function listSegments(db: D1Database, principal: Principal): Promise<SegmentSummary[]> {
  requireOrg(principal);
  const res = await db
    .prepare(`SELECT id, name, kind, query, member_ids, created_at FROM crm_segment ORDER BY created_at DESC`)
    .all<{ id: string; name: string; kind: 'dynamic' | 'curated'; query: string; member_ids: string | null; created_at: number }>();

  const out: SegmentSummary[] = [];
  for (const s of res.results) {
    let memberCount: number;
    if (s.kind === 'curated' && s.member_ids) {
      memberCount = (JSON.parse(s.member_ids) as string[]).length;
    } else {
      const d = await crmDirectory(db, principal, directoryOptsFromQuery(s.query));
      memberCount = d.rows.length;
    }
    out.push({ id: s.id, name: s.name, kind: s.kind, memberCount, createdAt: s.created_at });
  }
  return out;
}

export type SegmentDetail = { id: string; name: string; kind: 'dynamic' | 'curated'; rows: ContactRow[] };

export async function segmentDetail(db: D1Database, principal: Principal, id: string): Promise<SegmentDetail | null> {
  requireOrg(principal);
  const seg = await db
    .prepare(`SELECT id, name, kind, query, member_ids FROM crm_segment WHERE id = ?`)
    .bind(id)
    .first<{ id: string; name: string; kind: 'dynamic' | 'curated'; query: string; member_ids: string | null }>();
  if (!seg) return null;

  if (seg.kind === 'curated' && seg.member_ids) {
    const ids = JSON.parse(seg.member_ids) as string[];
    if (ids.length === 0) return { id: seg.id, name: seg.name, kind: seg.kind, rows: [] };
    const all = await crmDirectory(db, principal, {});
    const idSet = new Set(ids);
    return { id: seg.id, name: seg.name, kind: seg.kind, rows: all.rows.filter((r) => idSet.has(r.personId)) };
  }
  const d = await crmDirectory(db, principal, directoryOptsFromQuery(seg.query));
  return { id: seg.id, name: seg.name, kind: seg.kind, rows: d.rows };
}

/* ------------------------------------------------------------------ *
 * The sourcing pipeline — CRM-07, CRM-08
 * ------------------------------------------------------------------ */

export const PIPELINE_STAGES: readonly { value: string; word: string }[] = [
  { value: 'researching', word: 'Researching' },
  { value: 'identified', word: 'Identified' },
  { value: 'contacted', word: 'Contacted' },
  { value: 'interested', word: 'Interested' },
  { value: 'confirmed', word: 'Confirmed' },
  { value: 'declined', word: 'Declined' },
];

export type PipelineCard = {
  cardId: string;
  personId: string;
  name: string;
  organisation: string | null;
  stage: string;
  score: number | null;
  rationale: string | null;
  updatedAt: number;
};

export type PipelineBoard = { stages: { value: string; word: string; cards: PipelineCard[] }[] };

export async function pipelineBoard(db: D1Database, principal: Principal): Promise<PipelineBoard> {
  requireOrg(principal);
  const res = await db
    .prepare(
      `SELECT c.id, c.person_id, c.stage, c.score, c.rationale, c.updated_at,
              pe.name, pe.organisation
       FROM crm_card c JOIN person pe ON pe.id = c.person_id
       WHERE pe.merged_into_id IS NULL
       ORDER BY c.updated_at DESC`
    )
    .all<{
      id: string;
      person_id: string;
      stage: string;
      score: number | null;
      rationale: string | null;
      updated_at: number;
      name: string;
      organisation: string | null;
    }>();

  const byStage = new Map<string, PipelineCard[]>();
  for (const r of res.results) {
    const list = byStage.get(r.stage) ?? [];
    list.push({
      cardId: r.id,
      personId: r.person_id,
      name: r.name,
      organisation: r.organisation,
      stage: r.stage,
      score: r.score,
      rationale: r.rationale,
      updatedAt: r.updated_at,
    });
    byStage.set(r.stage, list);
  }

  return {
    stages: PIPELINE_STAGES.map((s) => ({ value: s.value, word: s.word, cards: byStage.get(s.value) ?? [] })),
  };
}

export type CardTransition = { id: string; fromStage: string | null; toStage: string; createdAt: number };

export type CardDetail = {
  cardId: string;
  personId: string;
  name: string;
  organisation: string | null;
  jobTitle: string | null;
  bio: string | null;
  stage: string;
  score: number | null;
  rationale: string | null;
  notes: ContactNote[];
  history: CardTransition[];
};

export async function cardDetail(db: D1Database, principal: Principal, cardId: string): Promise<CardDetail | null> {
  requireOrg(principal);
  const [cardRes, noteRes, histRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT c.id, c.person_id, c.stage, c.score, c.rationale,
                pe.name, pe.organisation, pe.job_title, pe.bio
         FROM crm_card c JOIN person pe ON pe.id = c.person_id
         WHERE c.id = ?`
      )
      .bind(cardId),
    db
      .prepare(
        `SELECT n.id, n.body, n.created_at, pe.name AS author_name
         FROM crm_note n JOIN person pe ON pe.id = n.author_id
         WHERE n.owner_kind = 'card' AND n.owner_id = ?
         ORDER BY n.created_at DESC`
      )
      .bind(cardId),
    db
      .prepare(
        `SELECT id, from_stage, to_stage, created_at FROM crm_card_event
         WHERE card_id = ? ORDER BY created_at DESC`
      )
      .bind(cardId),
  ]);

  const c = rowsOf<{
    id: string;
    person_id: string;
    stage: string;
    score: number | null;
    rationale: string | null;
    name: string;
    organisation: string | null;
    job_title: string | null;
    bio: string | null;
  }>(cardRes)[0];
  if (!c) return null;

  return {
    cardId: c.id,
    personId: c.person_id,
    name: c.name,
    organisation: c.organisation,
    jobTitle: c.job_title,
    bio: c.bio,
    stage: c.stage,
    score: c.score,
    rationale: c.rationale,
    notes: rowsOf<{ id: string; body: string; created_at: number; author_name: string }>(noteRes).map((n) => ({
      id: n.id,
      body: n.body,
      authorName: n.author_name,
      createdAt: n.created_at,
    })),
    history: rowsOf<{ id: string; from_stage: string | null; to_stage: string; created_at: number }>(histRes).map(
      (h) => ({ id: h.id, fromStage: h.from_stage, toStage: h.to_stage, createdAt: h.created_at })
    ),
  };
}

/* ------------------------------------------------------------------ *
 * The dashboard — CRM-12
 * ------------------------------------------------------------------ */

export type CrmDashboard = {
  totalContacts: number;
  totalEvents: number;
  returningSpeakers: number;
  topCompanies: { organisation: string; count: number }[];
};

export async function crmDashboard(db: D1Database, principal: Principal): Promise<CrmDashboard> {
  requireOrg(principal);
  const [totalRes, eventsRes, returningRes, companyRes] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT COUNT(*) AS n FROM person WHERE internal_role IS NULL AND merged_into_id IS NULL`),
    db.prepare(`SELECT COUNT(*) AS n FROM event`),
    // A returning speaker: non-draft participation at 2+ distinct events.
    db.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT pa.person_id FROM participation pa JOIN submission s ON s.id = pa.submission_id
         WHERE s.state <> 'draft'
         GROUP BY pa.person_id
         HAVING COUNT(DISTINCT s.event_id) >= 2
       )`
    ),
    db.prepare(
      `SELECT organisation, COUNT(*) AS n FROM person
       WHERE internal_role IS NULL AND merged_into_id IS NULL
         AND organisation IS NOT NULL AND trim(organisation) <> ''
       GROUP BY organisation ORDER BY n DESC, organisation LIMIT 5`
    ),
  ]);

  return {
    totalContacts: rowsOf<{ n: number }>(totalRes)[0]?.n ?? 0,
    totalEvents: rowsOf<{ n: number }>(eventsRes)[0]?.n ?? 0,
    returningSpeakers: rowsOf<{ n: number }>(returningRes)[0]?.n ?? 0,
    topCompanies: rowsOf<{ organisation: string; n: number }>(companyRes).map((r) => ({
      organisation: r.organisation,
      count: r.n,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * The roster-only supplement — feeds routes/admin/people.ts (SPK-03).
 *
 * A person who has been imported or pushed onto an event's list but has no
 * proposal there yet is invisible to queries/people.ts's peopleList (it
 * reads participation, on purpose — that file's whole point is "everyone
 * attached through a real proposal"). This is that gap's other half: the
 * same event's roster_entry rows, for exactly the people peopleList would
 * not otherwise find.
 * ------------------------------------------------------------------ */

export type RosterOnlyRow = {
  personId: string;
  name: string;
  jobTitle: string | null;
  organisation: string | null;
  openTaskCount: number;
};

export async function rosterOnlyPeople(
  db: D1Database,
  principal: Principal,
  eventId: string
): Promise<RosterOnlyRow[]> {
  // Reading one event's roster gap is an event-scoped fact, not an
  // org-level one — an editor on this conference may see it even without
  // the install-wide organizer standing requireOrg asks for elsewhere in
  // this file. The caller (people.ts) has already proven that standing via
  // resolveEvent before this runs.
  const res = await db
    .prepare(
      `SELECT pe.id, pe.name, pe.job_title, pe.organisation
       FROM roster_entry r
       JOIN person pe ON pe.id = r.person_id
       WHERE r.event_id = ?
         AND pe.merged_into_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM participation pa JOIN submission s ON s.id = pa.submission_id
           WHERE pa.person_id = pe.id AND s.event_id = ? AND s.state <> 'draft'
         )
       ORDER BY pe.name`
    )
    .bind(eventId, eventId)
    .all<{ id: string; name: string; job_title: string | null; organisation: string | null }>();

  if (res.results.length === 0) return [];
  const ids = res.results.map((r) => r.id);
  const openTasks = new Map<string, number>();
  for (const part of chunk(ids, ID_CHUNK)) {
    const taskRes = await db
      .prepare(
        `SELECT person_id, COUNT(*) AS n FROM task
         WHERE event_id = ? AND completed_at IS NULL AND cancelled_at IS NULL
           AND person_id IN (${inClause(part.length)})
         GROUP BY person_id`
      )
      .bind(eventId, ...part)
      .all<{ person_id: string; n: number }>();
    for (const t of taskRes.results) openTasks.set(t.person_id, t.n);
  }

  return res.results.map((r) => ({
    personId: r.id,
    name: r.name,
    jobTitle: r.job_title,
    organisation: r.organisation,
    openTaskCount: openTasks.get(r.id) ?? 0,
  }));
}
