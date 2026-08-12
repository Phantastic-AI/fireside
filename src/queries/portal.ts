// The speaker's own read path. Scoped by personId — the signed-in speaker, or
// the holder of a portal token; never a Principal, because a speaker has no
// standing on anything but their own submissions.
//
// DTOs carry internal enums and computed facts only; words come from
// lib/labels.ts at render time.

import { eventDayKey, lifecycleOf, initialsOf, type Lifecycle } from './public';

/**
 * THE NOT-TOLD INVISIBILITY RULE (02 §1.3, and the product's own thesis:
 * "a decision leaves when you send it, not when you make it"). A decision that
 * has been made but not delivered is invisible to the speaker: the portal shows
 * the submitted-equivalent state and no decision facts at all. The organizer's
 * mirror image of this expression lives in admin.ts as DECIDED_NOT_TOLD_SQL —
 * the two must always name the same set.
 *
 * This is enforced in the projection, so no template can reach the real state.
 */
const VISIBLE_STATE_SQL = `
  CASE WHEN s.notified_at IS NULL AND s.state IN ('accepted','waitlisted','rejected')
       THEN 'submitted' ELSE s.state END`;

const TOLD = 's.notified_at IS NOT NULL';

/* ------------------------------------------------------------------ *
 * DTOs
 * ------------------------------------------------------------------ */

/** What a speaker can be shown. 'accepted' | 'waitlisted' | 'rejected' appear
 *  only once told; until then the state reads 'submitted'. */
export type VisibleState =
  | 'draft'
  | 'submitted'
  | 'accepted'
  | 'waitlisted'
  | 'rejected'
  | 'withdrawn'
  | 'cancelled';

export type TaskStatus = 'open' | 'done' | 'cancelled' | 'done_cancelled';

export type PortalTask = {
  id: string;
  submissionId: string | null;
  kind: string;
  templateKey: string | null;
  title: string;
  instructions: string | null;
  dueOn: string | null;
  completedAt: number | null;
  status: TaskStatus;
  overdue: boolean;
};

export type PortalMessage = {
  id: string;
  submissionId: string | null;
  kind: string;
  subject: string;
  body: string;
  deliveredAt: number;
  emailedAt: number | null;
};

export type PortalPlacement = { startsAt: number; day: string; roomName: string | null };

export type PortalSubmission = {
  id: string;
  title: string;
  abstract: string | null;
  format: string;
  level: string | null;
  minutes: number;
  track: { slug: string; name: string; colour: string } | null;
  /** The told-gated state. The real state is deliberately not in this DTO. */
  state: VisibleState;
  told: boolean;
  toldAt: number | null;
  createdAt: number;
  submittedAt: number | null;
  /** Present only once told. */
  decision: { decidedAt: number | null; note: string | null } | null;
  /** Present only once told. */
  cancelled: { at: number; note: string | null } | null;
  /** Present only once told AND the agenda is public. */
  placement: PortalPlacement | null;
  /** True when a time and room exist but the agenda is not public yet — the
   *  fact without the values, so the portal can say so without leaking them. */
  scheduledNotPublic: boolean;
  publicSlug: string | null;
  /** A draft's resume nonce: the half-written proposal that survives a dead battery. */
  resumeNonce: string | null;
  answers: Record<string, unknown>;
  tasks: PortalTask[];
  messages: PortalMessage[];
};

export type PortalProfile = {
  personId: string;
  name: string;
  email: string | null;
  bio: string | null;
  jobTitle: string | null;
  organisation: string | null;
  links: string | null;
  pronouns: string | null;
  phone: string | null;
  headshotFileId: string | null;
  initials: string;
  shareContact: Record<string, unknown>;
};

export type PortalEvent = {
  id: string;
  slug: string;
  name: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
  tzLabel: string | null;
  venueName: string | null;
  agendaPublished: boolean;
  lifecycle: Lifecycle;
  cfpClosesAt: number | null;
  cfpSuccessMessage: string | null;
  decideBy: string | null;
  maxSubmissions: number;
  /** How many more they may send: max_submissions minus what is already in. */
  submissionsLeft: number;
};

export type PortalView = {
  event: PortalEvent;
  profile: PortalProfile;
  submissions: PortalSubmission[];
  /** Tasks and letters that belong to the event rather than to one talk. */
  tasks: PortalTask[];
  messages: PortalMessage[];
};

/* ------------------------------------------------------------------ *
 * Row shapes
 * ------------------------------------------------------------------ */

type EventRow = {
  id: string;
  slug: string;
  name: string;
  starts_on: string;
  ends_on: string;
  timezone: string;
  tz_label: string | null;
  venue_name: string | null;
  agenda_published: number;
  cfp_closes_at: number | null;
  cfp_success_message: string | null;
  decide_by: string | null;
  max_submissions: number;
};

type SubmissionRow = {
  id: string;
  title: string;
  abstract: string | null;
  format: string;
  level: string | null;
  requested_min: number;
  extra: string;
  created_at: number;
  submitted_at: number | null;
  resume_nonce: string | null;
  visible_state: VisibleState;
  told: number;
  notified_at: number | null;
  decided_at: number | null;
  decision_note: string | null;
  cancelled_at: number | null;
  cancel_note: string | null;
  starts_at: number | null;
  scheduled_not_public: number;
  room_name: string | null;
  public_slug: string | null;
  track_slug: string | null;
  track_name: string | null;
  track_colour: string | null;
};

type TaskRow = {
  id: string;
  submission_id: string | null;
  kind: string;
  template_key: string | null;
  title: string;
  instructions: string | null;
  due_on: string | null;
  completed_at: number | null;
  cancelled_at: number | null;
};

type MessageRow = {
  id: string;
  submission_id: string | null;
  kind: string;
  subject: string;
  body: string;
  delivered_at: number;
  emailed_at: number | null;
};

type PersonRow = {
  id: string;
  name: string;
  email: string | null;
  bio: string | null;
  job_title: string | null;
  organisation: string | null;
  links: string | null;
  pronouns: string | null;
  phone: string | null;
  headshot_file_id: string | null;
  share_contact: string;
};

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

function taskStatus(row: TaskRow): TaskStatus {
  if (row.cancelled_at !== null) return row.completed_at !== null ? 'done_cancelled' : 'cancelled';
  return row.completed_at !== null ? 'done' : 'open';
}

function toTask(row: TaskRow, todayIso: string): PortalTask {
  const status = taskStatus(row);
  return {
    id: row.id,
    submissionId: row.submission_id,
    kind: row.kind,
    templateKey: row.template_key,
    title: row.title,
    instructions: row.instructions,
    dueOn: row.due_on,
    completedAt: row.completed_at,
    status,
    overdue: status === 'open' && row.due_on !== null && row.due_on < todayIso,
  };
}

function toMessage(row: MessageRow): PortalMessage {
  return {
    id: row.id,
    submissionId: row.submission_id,
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    deliveredAt: row.delivered_at,
    emailedAt: row.emailed_at,
  };
}

/* ------------------------------------------------------------------ *
 * The query
 * ------------------------------------------------------------------ */

/**
 * One speaker's whole standing at one event: their talks (told-gated), the
 * tasks they owe, the letters they have actually received, and the profile
 * fields behind "Save my profile".
 *
 * Null when the event or the person is nobody.
 */
export async function portalView(
  db: D1Database,
  eventId: string,
  personId: string,
  nowMs: number = Date.now()
): Promise<PortalView | null> {
  const [eventRes, personRes, submissionRes, taskRes, messageRes] = await db.batch<
    Record<string, unknown>
  >([
    db
      .prepare(
        `SELECT id, slug, name, starts_on, ends_on, timezone, tz_label, venue_name,
                agenda_published, cfp_closes_at, cfp_success_message, decide_by, max_submissions
         FROM event WHERE id = ?`
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT id, name, email, bio, job_title, organisation, links, pronouns, phone,
                headshot_file_id, share_contact
         FROM person WHERE id = ?`
      )
      .bind(personId),
    db
      .prepare(
        `SELECT s.id, s.title, s.abstract, s.format, s.level, s.requested_min, s.extra,
                s.created_at, s.submitted_at, s.resume_nonce,
                ${VISIBLE_STATE_SQL} AS visible_state,
                CASE WHEN ${TOLD} THEN 1 ELSE 0 END AS told,
                CASE WHEN ${TOLD} THEN s.notified_at END AS notified_at,
                CASE WHEN ${TOLD} THEN s.decided_at END AS decided_at,
                CASE WHEN ${TOLD} THEN s.decision_note END AS decision_note,
                CASE WHEN ${TOLD} THEN s.cancelled_at END AS cancelled_at,
                CASE WHEN ${TOLD} THEN s.cancel_note END AS cancel_note,
                CASE WHEN ${TOLD} AND e.agenda_published = 1 THEN s.starts_at END AS starts_at,
                CASE WHEN ${TOLD} AND e.agenda_published = 1 THEN r.name END AS room_name,
                CASE WHEN ${TOLD} AND e.agenda_published = 1 THEN s.public_slug END AS public_slug,
                CASE WHEN ${TOLD} AND e.agenda_published = 0 AND s.starts_at IS NOT NULL
                     THEN 1 ELSE 0 END AS scheduled_not_public,
                t.slug AS track_slug, t.name AS track_name, t.colour AS track_colour
         FROM submission s
         JOIN event e ON e.id = s.event_id
         JOIN participation pa ON pa.submission_id = s.id
         LEFT JOIN room r ON r.id = s.room_id
         LEFT JOIN track t ON t.id = s.track_id
         WHERE s.event_id = ? AND pa.person_id = ?
         ORDER BY COALESCE(s.submitted_at, s.created_at) DESC, s.title`
      )
      .bind(eventId, personId),
    db
      .prepare(
        `SELECT id, submission_id, kind, template_key, title, instructions, due_on,
                completed_at, cancelled_at
         FROM task
         WHERE event_id = ? AND person_id = ?
         ORDER BY completed_at IS NOT NULL, due_on IS NULL, due_on, title`
      )
      .bind(eventId, personId),
    // Delivered only. A staged letter is part of the same un-told decision the
    // rule above hides — the speaker learns of it when it is sent, not before.
    db
      .prepare(
        `SELECT id, submission_id, kind, subject, body, delivered_at, emailed_at
         FROM message
         WHERE event_id = ? AND person_id = ? AND delivered_at IS NOT NULL
         ORDER BY delivered_at DESC, id`
      )
      .bind(eventId, personId),
  ]);

  const ev = rowsOf<EventRow>(eventRes)[0];
  const person = rowsOf<PersonRow>(personRes)[0];
  if (!ev || !person) return null;

  const todayIso = eventDayKey(nowMs, ev.timezone);
  const tasks = rowsOf<TaskRow>(taskRes).map((t) => toTask(t, todayIso));
  const messages = rowsOf<MessageRow>(messageRes).map(toMessage);

  const tasksBySubmission = new Map<string, PortalTask[]>();
  for (const t of tasks) {
    if (!t.submissionId) continue;
    const list = tasksBySubmission.get(t.submissionId) ?? [];
    list.push(t);
    tasksBySubmission.set(t.submissionId, list);
  }
  const messagesBySubmission = new Map<string, PortalMessage[]>();
  for (const m of messages) {
    if (!m.submissionId) continue;
    const list = messagesBySubmission.get(m.submissionId) ?? [];
    list.push(m);
    messagesBySubmission.set(m.submissionId, list);
  }

  const submissions: PortalSubmission[] = rowsOf<SubmissionRow>(submissionRes).map((r) => {
    const told = r.told === 1;
    return {
      id: r.id,
      title: r.title,
      abstract: r.abstract,
      format: r.format,
      level: r.level,
      minutes: r.requested_min,
      track:
        r.track_slug && r.track_name && r.track_colour
          ? { slug: r.track_slug, name: r.track_name, colour: r.track_colour }
          : null,
      state: r.visible_state,
      told,
      toldAt: r.notified_at,
      createdAt: r.created_at,
      submittedAt: r.submitted_at,
      decision: told ? { decidedAt: r.decided_at, note: r.decision_note } : null,
      cancelled:
        told && r.cancelled_at !== null ? { at: r.cancelled_at, note: r.cancel_note } : null,
      placement:
        r.starts_at !== null
          ? {
              startsAt: r.starts_at,
              day: eventDayKey(r.starts_at, ev.timezone),
              roomName: r.room_name,
            }
          : null,
      scheduledNotPublic: r.scheduled_not_public === 1,
      publicSlug: r.public_slug,
      resumeNonce: r.visible_state === 'draft' ? r.resume_nonce : null,
      answers: asObject(r.extra),
      tasks: tasksBySubmission.get(r.id) ?? [],
      messages: messagesBySubmission.get(r.id) ?? [],
    };
  });

  const inFlight = submissions.filter((s) => s.state !== 'withdrawn' && s.state !== 'draft').length;

  return {
    event: {
      id: ev.id,
      slug: ev.slug,
      name: ev.name,
      startsOn: ev.starts_on,
      endsOn: ev.ends_on,
      timezone: ev.timezone,
      tzLabel: ev.tz_label,
      venueName: ev.venue_name,
      agendaPublished: ev.agenda_published === 1,
      lifecycle: lifecycleOf(ev.ends_on, ev.cfp_closes_at, ev.timezone, nowMs),
      cfpClosesAt: ev.cfp_closes_at,
      cfpSuccessMessage: ev.cfp_success_message,
      decideBy: ev.decide_by,
      maxSubmissions: ev.max_submissions,
      submissionsLeft: Math.max(0, ev.max_submissions - inFlight),
    },
    profile: {
      personId: person.id,
      name: person.name,
      email: person.email,
      bio: person.bio,
      jobTitle: person.job_title,
      organisation: person.organisation,
      links: person.links,
      pronouns: person.pronouns,
      phone: person.phone,
      headshotFileId: person.headshot_file_id,
      initials: initialsOf(person.name),
      shareContact: asObject(person.share_contact),
    },
    submissions,
    tasks: tasks.filter((t) => t.submissionId === null),
    messages: messages.filter((m) => m.submissionId === null),
  };
}
