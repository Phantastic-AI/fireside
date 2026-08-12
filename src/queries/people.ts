// People — the backstage CRM read layer. Everyone who has ever touched this
// event through a participation row, deduped to one row per person, plus one
// person's whole file: contact facts, their proposals here, what they owe
// (and have already given), and their standing at every other event — the
// organizer's memory, not just this event's pile.
//
// A draft is not yet a proposal (01 inv., mirrored from admin.ts's own
// FILTER_SQL.all comment: "a draft has not been sent") — so a person whose
// only participation anywhere is on an unsent draft does not surface here,
// and a draft never counts toward "their proposals" or "elsewhere" either.
//
// Read-only. No writer touches this file's tables from here.
import type { Principal } from '../workflows/account';
import { requireScope, READ_ROLES, type SubmissionState } from './admin';

/* ------------------------------------------------------------------ *
 * DTOs
 * ------------------------------------------------------------------ */

export type PersonProposal = {
  id: string;
  title: string;
  state: SubmissionState;
};

export type PersonListRow = {
  personId: string;
  name: string;
  jobTitle: string | null;
  organisation: string | null;
  /** Their proposals at THIS event — draft excluded, most recent first. */
  proposals: PersonProposal[];
  /** Open tasks (not done, not cancelled) they hold at THIS event. */
  openTaskCount: number;
};

export type PeopleList = {
  eventId: string;
  search: string | null;
  rows: PersonListRow[];
};

export type PersonTask = {
  id: string;
  kind: string;
  title: string;
  dueOn: string | null;
  completedAt: number | null;
  cancelledAt: number | null;
  cancelReason: string | null;
};

export type PersonElsewhere = {
  submissionId: string;
  eventId: string;
  eventSlug: string;
  eventName: string;
  title: string;
  state: SubmissionState;
};

export type PersonDetail = {
  personId: string;
  name: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  organisation: string | null;
  bio: string | null;
  /** Their proposals at THIS event — draft excluded. */
  proposals: PersonProposal[];
  /** Every task they hold at THIS event, open and done alike. */
  tasks: PersonTask[];
  /** Their participation at every OTHER event, any state — the memory. */
  elsewhere: PersonElsewhere[];
};

/* ------------------------------------------------------------------ *
 * Row shapes and helpers
 * ------------------------------------------------------------------ */

function rowsOf<T>(res: D1Result<Record<string, unknown>> | undefined): T[] {
  return (res?.results ?? []) as unknown as T[];
}

/** LIKE with its wildcards taken away: a search for "50%" means "50%". */
function likePattern(search: string): string {
  return `%${search.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

/**
 * Everyone attached to this event through a participation row on a
 * non-draft proposal, deduped by person. `search` matches name, email, or
 * organisation — the three fields Naomi actually remembers someone by.
 */
export async function peopleList(
  db: D1Database,
  principal: Principal,
  eventId: string,
  opts: { search?: string } = {}
): Promise<PeopleList> {
  requireScope(principal, eventId, READ_ROLES);

  const search = opts.search?.trim() ? opts.search.trim() : null;
  const pattern = search ? likePattern(search) : null;
  const searchClause = pattern
    ? " AND (pe.name LIKE ? ESCAPE '\\' OR pe.email LIKE ? ESCAPE '\\' OR pe.organisation LIKE ? ESCAPE '\\')"
    : '';
  const searchBindings = pattern ? [pattern, pattern, pattern] : [];

  const [personRes, proposalRes, taskRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT DISTINCT pe.id, pe.name, pe.job_title, pe.organisation
         FROM person pe
         JOIN participation pa ON pa.person_id = pe.id
         JOIN submission s ON s.id = pa.submission_id
         WHERE s.event_id = ? AND s.state <> 'draft'${searchClause}
         ORDER BY pe.name`
      )
      .bind(eventId, ...searchBindings),
    // Every non-draft proposal at this event, for every person attached to
    // it — fetched once, unfiltered by search, and matched up in JS below
    // (the search only narrows which people surface, not what they carry).
    db
      .prepare(
        `SELECT pa.person_id, s.id, s.title, s.state
         FROM participation pa
         JOIN submission s ON s.id = pa.submission_id
         WHERE s.event_id = ? AND s.state <> 'draft'
         ORDER BY pa.person_id, s.submitted_at IS NULL, s.submitted_at DESC, s.created_at DESC, s.title`
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT person_id, COUNT(*) AS n
         FROM task
         WHERE event_id = ? AND completed_at IS NULL AND cancelled_at IS NULL
         GROUP BY person_id`
      )
      .bind(eventId),
  ]);

  const proposalsByPerson = new Map<string, PersonProposal[]>();
  for (const row of rowsOf<{ person_id: string; id: string; title: string; state: SubmissionState }>(
    proposalRes
  )) {
    const list = proposalsByPerson.get(row.person_id) ?? [];
    list.push({ id: row.id, title: row.title, state: row.state });
    proposalsByPerson.set(row.person_id, list);
  }

  const openTasksByPerson = new Map<string, number>();
  for (const row of rowsOf<{ person_id: string; n: number }>(taskRes)) {
    openTasksByPerson.set(row.person_id, row.n);
  }

  const rows: PersonListRow[] = rowsOf<{
    id: string;
    name: string;
    job_title: string | null;
    organisation: string | null;
  }>(personRes).map((p) => ({
    personId: p.id,
    name: p.name,
    jobTitle: p.job_title,
    organisation: p.organisation,
    proposals: proposalsByPerson.get(p.id) ?? [],
    openTaskCount: openTasksByPerson.get(p.id) ?? 0,
  }));

  return { eventId, search, rows };
}

/**
 * One person's whole file at this event, plus their memory everywhere else.
 * Returns null when the person is not attached to this event through any
 * non-draft participation row — the same gate `peopleList` uses, so a URL
 * cannot be walked to see someone who was never really here.
 */
export async function personDetail(
  db: D1Database,
  principal: Principal,
  eventId: string,
  personId: string
): Promise<PersonDetail | null> {
  requireScope(principal, eventId, READ_ROLES);

  const [personRes, proposalRes, taskRes, elseRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT pe.id, pe.name, pe.email, pe.phone, pe.job_title, pe.organisation, pe.bio
         FROM person pe
         WHERE pe.id = ?
           AND EXISTS (
             SELECT 1 FROM participation pa JOIN submission s ON s.id = pa.submission_id
             WHERE pa.person_id = pe.id AND s.event_id = ? AND s.state <> 'draft'
           )`
      )
      .bind(personId, eventId),
    db
      .prepare(
        `SELECT s.id, s.title, s.state
         FROM participation pa JOIN submission s ON s.id = pa.submission_id
         WHERE pa.person_id = ? AND s.event_id = ? AND s.state <> 'draft'
         ORDER BY s.submitted_at IS NULL, s.submitted_at DESC, s.created_at DESC, s.title`
      )
      .bind(personId, eventId),
    db
      .prepare(
        `SELECT id, kind, title, due_on, completed_at, cancelled_at, cancel_reason
         FROM task
         WHERE person_id = ? AND event_id = ?
         ORDER BY (completed_at IS NULL AND cancelled_at IS NULL) DESC, due_on IS NULL, due_on, title`
      )
      .bind(personId, eventId),
    // Cross-event history: every OTHER event this person has touched, any
    // state — backstage sees all of it, this is the organizer's memory
    // (02 §1.3 splits "decided but not told" for the telling act, not for
    // remembering who someone was last year).
    db
      .prepare(
        `SELECT s.id AS submission_id, e.id AS event_id, e.slug AS event_slug, e.name AS event_name,
                s.title, s.state
         FROM participation pa
         JOIN submission s ON s.id = pa.submission_id
         JOIN event e ON e.id = s.event_id
         WHERE pa.person_id = ? AND s.event_id <> ? AND s.state <> 'draft'
         ORDER BY e.starts_on DESC, s.title`
      )
      .bind(personId, eventId),
  ]);

  const p = rowsOf<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    job_title: string | null;
    organisation: string | null;
    bio: string | null;
  }>(personRes)[0];
  if (!p) return null;

  return {
    personId: p.id,
    name: p.name,
    email: p.email,
    phone: p.phone,
    jobTitle: p.job_title,
    organisation: p.organisation,
    bio: p.bio,
    proposals: rowsOf<{ id: string; title: string; state: SubmissionState }>(proposalRes).map((r) => ({
      id: r.id,
      title: r.title,
      state: r.state,
    })),
    tasks: rowsOf<{
      id: string;
      kind: string;
      title: string;
      due_on: string | null;
      completed_at: number | null;
      cancelled_at: number | null;
      cancel_reason: string | null;
    }>(taskRes).map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      dueOn: t.due_on,
      completedAt: t.completed_at,
      cancelledAt: t.cancelled_at,
      cancelReason: t.cancel_reason,
    })),
    elsewhere: rowsOf<{
      submission_id: string;
      event_id: string;
      event_slug: string;
      event_name: string;
      title: string;
      state: SubmissionState;
    }>(elseRes).map((e) => ({
      submissionId: e.submission_id,
      eventId: e.event_id,
      eventSlug: e.event_slug,
      eventName: e.event_name,
      title: e.title,
      state: e.state,
    })),
  };
}
