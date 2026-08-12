// The public read path. No Principal: everything here is what a stranger sees,
// so the scope rules are written into the SQL rather than trusted to a caller.
//
// DTOs carry internal enums and computed facts only — never display strings.
// Words come from lib/labels.ts at render time (02 §6, "one place, one string").
//
// Times: *_at columns are epoch ms; *_on columns are ISO dates. Day keys are
// computed in the event's own timezone, because a conference day is a local fact.

/* ------------------------------------------------------------------ *
 * The rules, written once.
 * ------------------------------------------------------------------ */

/** The decisions a stranger may see. A rejection is never public, ever. */
const PUBLIC_STATES = "s.state IN ('accepted','cancelled')";

/**
 * The public agenda rule, shared verbatim by `agenda` and `sessionBySlug` so a
 * session page can never be reachable when the same talk is absent from the
 * agenda. Cancelled stays in place, struck through (01 inv. 2/Δ4).
 */
const PUBLIC_AGENDA_RULE = `${PUBLIC_STATES} AND s.starts_at IS NOT NULL AND e.agenda_published = 1`;

export type Lifecycle = 'open' | 'closed' | 'happened';

export type PublicState = 'accepted' | 'cancelled';

/**
 * Lifecycle is derived, never stored. One expression, used by every surface
 * that shows an event: past its last day it happened; before the call closes it
 * is open; anything else is closed. "Today" is the event's own today, because
 * a conference ends on a local evening, not at a UTC midnight.
 */
export function lifecycleOf(
  endsOn: string,
  cfpClosesAt: number | null,
  timezone: string,
  nowMs: number = Date.now()
): Lifecycle {
  if (endsOn < eventDayKey(nowMs, timezone)) return 'happened';
  if (cfpClosesAt !== null && cfpClosesAt > nowMs) return 'open';
  return 'closed';
}

/** The local ISO day of an instant, in the event's own timezone. */
export function eventDayKey(startsAt: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(startsAt));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The headshot placeholder: two letters, deterministic, no image request. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

function rowsOf<T>(res: D1Result<Record<string, unknown>> | undefined): T[] {
  return (res?.results ?? []) as unknown as T[];
}

/* ------------------------------------------------------------------ *
 * DTOs
 * ------------------------------------------------------------------ */

export type EventCounts = {
  /** Everything the committee was sent: drafts are not proposals yet. */
  proposals: number;
  /** Accepted plus cancelled — a cancelled talk was accepted (01 inv. 2). */
  accepted: number;
  /** Distinct people holding an accepted-or-cancelled talk. */
  speakers: number;
};

export type EventCard = {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  startsOn: string;
  endsOn: string;
  timezone: string;
  tzLabel: string | null;
  venueName: string | null;
  venueAddress: string | null;
  accent: string | null;
  logoFileId: string | null;
  cfpOpensAt: number | null;
  cfpClosesAt: number | null;
  agendaPublished: boolean;
  lifecycle: Lifecycle;
  counts: EventCounts;
};

export type EventHome = EventCard & {
  cfpIntro: string | null;
  cfpSuccessMessage: string | null;
  decideBy: string | null;
  maxSubmissions: number;
  dayStart: string;
  dayEnd: string;
  blockMinutes: number;
};

export type SpeakerRef = {
  personId: string;
  name: string;
  role: 'speaker' | 'co_speaker' | 'moderator';
  position: number;
};

export type TrackRef = { slug: string; name: string; colour: string };

export type AgendaSession = {
  id: string;
  publicSlug: string | null;
  title: string;
  state: PublicState;
  cancelled: boolean;
  startsAt: number;
  minutes: number;
  format: string;
  roomId: string | null;
  roomName: string | null;
  track: TrackRef | null;
  speakers: SpeakerRef[];
  recordingUrl: string | null;
};

export type AgendaSlot = { startsAt: number; sessions: AgendaSession[] };
export type AgendaDay = { day: string; slots: AgendaSlot[] };
export type Agenda = {
  eventId: string;
  timezone: string;
  tzLabel: string | null;
  published: boolean;
  days: AgendaDay[];
};

export type PublicSpeaker = {
  personId: string;
  name: string;
  jobTitle: string | null;
  organisation: string | null;
  bio: string | null;
  pronouns: string | null;
  links: string | null;
  headshotFileId: string | null;
  initials: string;
  role: 'speaker' | 'co_speaker' | 'moderator';
  position: number;
};

export type PublicSession = {
  id: string;
  publicSlug: string;
  title: string;
  abstract: string | null;
  format: string;
  level: string | null;
  minutes: number;
  state: PublicState;
  cancelled: boolean;
  cancelNote: string | null;
  startsAt: number;
  day: string;
  roomName: string | null;
  track: TrackRef | null;
  recordingUrl: string | null;
  timezone: string;
  tzLabel: string | null;
  speakers: PublicSpeaker[];
};

/** A speaker's talk as the gallery shows it. Title/time/room are absent until
 *  the agenda is published — see `speakersGallery`. */
export type GallerySession = {
  id: string;
  publicSlug: string | null;
  title: string | null;
  startsAt: number | null;
  day: string | null;
  roomName: string | null;
  track: TrackRef | null;
  state: PublicState;
  cancelled: boolean;
};

export type GallerySpeaker = {
  personId: string;
  name: string;
  sortName: string | null;
  jobTitle: string | null;
  organisation: string | null;
  bio: string | null;
  pronouns: string | null;
  links: string | null;
  headshotFileId: string | null;
  initials: string;
  /** How many accepted-or-cancelled talks they hold here — safe before publication. */
  talkCount: number;
  /** Empty until the agenda is published (the gallery rule). */
  sessions: GallerySession[];
};

export type ElsewhereTalk = {
  submissionId: string;
  eventId: string;
  eventSlug: string;
  eventName: string;
  year: string;
  title: string;
  state: PublicState;
  publicSlug: string | null;
  startsAt: number | null;
};

export type SpeakerPage = {
  person: Omit<GallerySpeaker, 'talkCount' | 'sessions'>;
  agendaPublished: boolean;
  sessions: GallerySession[];
  elsewhere: ElsewhereTalk[];
};

export type CfpQuestionKind = 'short' | 'long' | 'select' | 'checkbox';

export type CfpQuestion = {
  id: string;
  kind: CfpQuestionKind;
  label: string;
  hint: string | null;
  required: boolean;
  options: string[] | null;
  showIf: { questionId: string; equals: string } | null;
  position: number;
};

/* ------------------------------------------------------------------ *
 * Row shapes (SQL ↔ DTO seam)
 * ------------------------------------------------------------------ */

type EventRow = {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  starts_on: string;
  ends_on: string;
  timezone: string;
  tz_label: string | null;
  venue_name: string | null;
  venue_address: string | null;
  accent: string | null;
  logo_file_id: string | null;
  cfp_opens_at: number | null;
  cfp_closes_at: number | null;
  cfp_intro: string | null;
  cfp_success_message: string | null;
  decide_by: string | null;
  max_submissions: number;
  day_start: string;
  day_end: string;
  block_minutes: number;
  agenda_published: number;
  proposals: number;
  accepted: number;
  speakers: number;
};

type SessionRow = {
  id: string;
  public_slug: string | null;
  title: string;
  abstract: string | null;
  state: PublicState;
  starts_at: number;
  requested_min: number;
  format: string;
  level: string | null;
  cancel_note: string | null;
  recording_url: string | null;
  room_id: string | null;
  room_name: string | null;
  track_slug: string | null;
  track_name: string | null;
  track_colour: string | null;
};

type SpeakerRow = {
  submission_id: string;
  person_id: string;
  name: string;
  sort_name: string | null;
  job_title: string | null;
  organisation: string | null;
  bio: string | null;
  pronouns: string | null;
  links: string | null;
  headshot_file_id: string | null;
  role: 'speaker' | 'co_speaker' | 'moderator';
  position: number;
};

const EVENT_COLUMNS = `
  e.id, e.slug, e.name, e.tagline, e.starts_on, e.ends_on, e.timezone, e.tz_label,
  e.venue_name, e.venue_address, e.accent, e.logo_file_id,
  e.cfp_opens_at, e.cfp_closes_at, e.cfp_intro, e.cfp_success_message,
  e.decide_by, e.max_submissions, e.day_start, e.day_end, e.block_minutes,
  e.agenda_published`;

// One pass over the join: three counts, no correlated subqueries.
const EVENT_COUNTS = `
  COUNT(DISTINCT CASE WHEN s.state <> 'draft' THEN s.id END) AS proposals,
  COUNT(DISTINCT CASE WHEN s.state IN ('accepted','cancelled') THEN s.id END) AS accepted,
  COUNT(DISTINCT CASE WHEN s.state IN ('accepted','cancelled') THEN pa.person_id END) AS speakers`;

const EVENT_JOIN = `
  FROM event e
  LEFT JOIN submission s ON s.event_id = e.id
  LEFT JOIN participation pa ON pa.submission_id = s.id`;

function toCard(r: EventRow, nowMs: number): EventCard {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    tagline: r.tagline,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    timezone: r.timezone,
    tzLabel: r.tz_label,
    venueName: r.venue_name,
    venueAddress: r.venue_address,
    accent: r.accent,
    logoFileId: r.logo_file_id,
    cfpOpensAt: r.cfp_opens_at,
    cfpClosesAt: r.cfp_closes_at,
    agendaPublished: r.agenda_published === 1,
    lifecycle: lifecycleOf(r.ends_on, r.cfp_closes_at, r.timezone, nowMs),
    counts: { proposals: r.proposals, accepted: r.accepted, speakers: r.speakers },
  };
}

function toTrack(slug: string | null, name: string | null, colour: string | null): TrackRef | null {
  return slug && name && colour ? { slug, name, colour } : null;
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

/** The landing cards: one row per event, with its three public counts. */
export async function listEvents(db: D1Database, nowMs: number = Date.now()): Promise<EventCard[]> {
  const res = await db
    .prepare(
      `SELECT ${EVENT_COLUMNS}, ${EVENT_COUNTS} ${EVENT_JOIN}
       GROUP BY e.id
       ORDER BY e.starts_on DESC, e.name`
    )
    .all<EventRow>();
  return res.results.map((r) => toCard(r, nowMs));
}

/** Everything the event home needs, in one row. Null when the slug is nobody's. */
export async function eventBySlug(
  db: D1Database,
  slug: string,
  nowMs: number = Date.now()
): Promise<EventHome | null> {
  const r = await db
    .prepare(
      `SELECT ${EVENT_COLUMNS}, ${EVENT_COUNTS} ${EVENT_JOIN}
       WHERE e.slug = ?
       GROUP BY e.id`
    )
    .bind(slug)
    .first<EventRow>();
  if (!r) return null;
  return {
    ...toCard(r, nowMs),
    cfpIntro: r.cfp_intro,
    cfpSuccessMessage: r.cfp_success_message,
    decideBy: r.decide_by,
    maxSubmissions: r.max_submissions,
    dayStart: r.day_start,
    dayEnd: r.day_end,
    blockMinutes: r.block_minutes,
  };
}

/** The public agenda: day → time → room. Empty days when nothing is published. */
export async function agenda(db: D1Database, eventId: string): Promise<Agenda | null> {
  const [eventRes, sessionRes, speakerRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare('SELECT id, timezone, tz_label, agenda_published FROM event WHERE id = ?')
      .bind(eventId),
    db
      .prepare(
        `SELECT s.id, s.public_slug, s.title, s.state, s.starts_at, s.requested_min, s.format,
                s.cancel_note, s.recording_url,
                r.id AS room_id, r.name AS room_name,
                t.slug AS track_slug, t.name AS track_name, t.colour AS track_colour
         FROM submission s
         JOIN event e ON e.id = s.event_id
         LEFT JOIN room r ON r.id = s.room_id
         LEFT JOIN track t ON t.id = s.track_id
         WHERE s.event_id = ? AND ${PUBLIC_AGENDA_RULE}
         ORDER BY s.starts_at, r.position, r.name, s.title`
      )
      .bind(eventId),
    db
      .prepare(
        `SELECT pa.submission_id, pe.id AS person_id, pe.name, pa.role, pa.position
         FROM participation pa
         JOIN person pe ON pe.id = pa.person_id
         JOIN submission s ON s.id = pa.submission_id
         JOIN event e ON e.id = s.event_id
         WHERE s.event_id = ? AND ${PUBLIC_AGENDA_RULE}
         ORDER BY pa.submission_id, pa.position, pe.name`
      )
      .bind(eventId),
  ]);

  const ev = rowsOf<{ id: string; timezone: string; tz_label: string | null; agenda_published: number }>(
    eventRes
  )[0];
  if (!ev) return null;

  const bySubmission = new Map<string, SpeakerRef[]>();
  for (const s of rowsOf<SpeakerRow>(speakerRes)) {
    const list = bySubmission.get(s.submission_id) ?? [];
    list.push({ personId: s.person_id, name: s.name, role: s.role, position: s.position });
    bySubmission.set(s.submission_id, list);
  }

  const days: AgendaDay[] = [];
  let day: AgendaDay | undefined;
  let slot: AgendaSlot | undefined;
  for (const row of rowsOf<SessionRow>(sessionRes)) {
    const key = eventDayKey(row.starts_at, ev.timezone);
    if (!day || day.day !== key) {
      day = { day: key, slots: [] };
      days.push(day);
      slot = undefined;
    }
    if (!slot || slot.startsAt !== row.starts_at) {
      slot = { startsAt: row.starts_at, sessions: [] };
      day.slots.push(slot);
    }
    slot.sessions.push({
      id: row.id,
      publicSlug: row.public_slug,
      title: row.title,
      state: row.state,
      cancelled: row.state === 'cancelled',
      startsAt: row.starts_at,
      minutes: row.requested_min,
      format: row.format,
      roomId: row.room_id,
      roomName: row.room_name,
      track: toTrack(row.track_slug, row.track_name, row.track_colour),
      speakers: bySubmission.get(row.id) ?? [],
      recordingUrl: row.recording_url,
    });
  }

  return {
    eventId: ev.id,
    timezone: ev.timezone,
    tzLabel: ev.tz_label,
    published: ev.agenda_published === 1,
    days,
  };
}

/** One session page. Null when it is not publicly visible by the agenda rule. */
export async function sessionBySlug(
  db: D1Database,
  eventId: string,
  publicSlug: string
): Promise<PublicSession | null> {
  const [eventRes, sessionRes, speakerRes] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT timezone, tz_label FROM event WHERE id = ?').bind(eventId),
    db
      .prepare(
        `SELECT s.id, s.public_slug, s.title, s.abstract, s.state, s.starts_at, s.requested_min,
                s.format, s.level, s.cancel_note, s.recording_url,
                r.id AS room_id, r.name AS room_name,
                t.slug AS track_slug, t.name AS track_name, t.colour AS track_colour
         FROM submission s
         JOIN event e ON e.id = s.event_id
         LEFT JOIN room r ON r.id = s.room_id
         LEFT JOIN track t ON t.id = s.track_id
         WHERE s.event_id = ? AND s.public_slug = ? AND ${PUBLIC_AGENDA_RULE}`
      )
      .bind(eventId, publicSlug),
    db
      .prepare(
        `SELECT pa.submission_id, pe.id AS person_id, pe.name, pe.sort_name, pe.job_title,
                pe.organisation, pe.bio, pe.pronouns, pe.links, pe.headshot_file_id,
                pa.role, pa.position
         FROM participation pa
         JOIN person pe ON pe.id = pa.person_id
         JOIN submission s ON s.id = pa.submission_id
         JOIN event e ON e.id = s.event_id
         WHERE s.event_id = ? AND s.public_slug = ? AND ${PUBLIC_AGENDA_RULE}
         ORDER BY pa.position, pe.name`
      )
      .bind(eventId, publicSlug),
  ]);

  const row = rowsOf<SessionRow>(sessionRes)[0];
  if (!row || !row.public_slug) return null;
  const ev = rowsOf<{ timezone: string; tz_label: string | null }>(eventRes)[0];
  const timezone = ev?.timezone ?? 'UTC';

  return {
    id: row.id,
    publicSlug: row.public_slug,
    title: row.title,
    abstract: row.abstract,
    format: row.format,
    level: row.level,
    minutes: row.requested_min,
    state: row.state,
    cancelled: row.state === 'cancelled',
    cancelNote: row.state === 'cancelled' ? row.cancel_note : null,
    startsAt: row.starts_at,
    day: eventDayKey(row.starts_at, timezone),
    roomName: row.room_name,
    track: toTrack(row.track_slug, row.track_name, row.track_colour),
    recordingUrl: row.recording_url,
    timezone,
    tzLabel: ev?.tz_label ?? null,
    speakers: rowsOf<SpeakerRow>(speakerRes).map((s) => ({
      personId: s.person_id,
      name: s.name,
      jobTitle: s.job_title,
      organisation: s.organisation,
      bio: s.bio,
      pronouns: s.pronouns,
      links: s.links,
      headshotFileId: s.headshot_file_id,
      initials: initialsOf(s.name),
      role: s.role,
      position: s.position,
    })),
  };
}

type GalleryRow = SpeakerRow & {
  sort_name: string | null;
  submission_id: string;
  sub_state: PublicState;
  agenda_published: number;
  public_slug: string | null;
  title: string | null;
  starts_at: number | null;
  room_name: string | null;
  track_slug: string | null;
  track_name: string | null;
  track_colour: string | null;
};

// THE GALLERY RULE (08 §2): the gallery lists the people holding an accepted or
// cancelled talk even before `agenda_published` — a speaker announcement is not
// the same act as publishing a schedule. Titles, times and rooms are gated on
// publication, in the projection below, so no caller can leak them by accident.
const GALLERY_SQL = `
  SELECT pe.id AS person_id, pe.name, pe.sort_name, pe.job_title, pe.organisation, pe.bio,
         pe.pronouns, pe.links, pe.headshot_file_id, pa.role, pa.position,
         s.id AS submission_id, s.state AS sub_state, e.agenda_published,
         CASE WHEN e.agenda_published = 1 THEN s.public_slug END AS public_slug,
         CASE WHEN e.agenda_published = 1 THEN s.title END AS title,
         CASE WHEN e.agenda_published = 1 THEN s.starts_at END AS starts_at,
         CASE WHEN e.agenda_published = 1 THEN r.name END AS room_name,
         CASE WHEN e.agenda_published = 1 THEN t.slug END AS track_slug,
         CASE WHEN e.agenda_published = 1 THEN t.name END AS track_name,
         CASE WHEN e.agenda_published = 1 THEN t.colour END AS track_colour
  FROM participation pa
  JOIN person pe ON pe.id = pa.person_id
  JOIN submission s ON s.id = pa.submission_id
  JOIN event e ON e.id = s.event_id
  LEFT JOIN room r ON r.id = s.room_id
  LEFT JOIN track t ON t.id = s.track_id
  WHERE s.event_id = ? AND ${PUBLIC_STATES}`;

function toGallerySession(r: GalleryRow, timezone: string): GallerySession {
  return {
    id: r.submission_id,
    publicSlug: r.public_slug,
    title: r.title,
    startsAt: r.starts_at,
    day: r.starts_at === null ? null : eventDayKey(r.starts_at, timezone),
    roomName: r.room_name,
    track: toTrack(r.track_slug, r.track_name, r.track_colour),
    state: r.sub_state,
    cancelled: r.sub_state === 'cancelled',
  };
}

/** The speaker gallery. Lists people before publication; titles only after. */
export async function speakersGallery(db: D1Database, eventId: string): Promise<GallerySpeaker[]> {
  const [eventRes, galleryRes] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT timezone FROM event WHERE id = ?').bind(eventId),
    db
      .prepare(`${GALLERY_SQL} ORDER BY COALESCE(pe.sort_name, pe.name), pe.name, s.starts_at, s.title`)
      .bind(eventId),
  ]);
  const timezone = rowsOf<{ timezone: string }>(eventRes)[0]?.timezone ?? 'UTC';

  const out: GallerySpeaker[] = [];
  const index = new Map<string, GallerySpeaker>();
  for (const r of rowsOf<GalleryRow>(galleryRes)) {
    let person = index.get(r.person_id);
    if (!person) {
      person = {
        personId: r.person_id,
        name: r.name,
        sortName: r.sort_name,
        jobTitle: r.job_title,
        organisation: r.organisation,
        bio: r.bio,
        pronouns: r.pronouns,
        links: r.links,
        headshotFileId: r.headshot_file_id,
        initials: initialsOf(r.name),
        talkCount: 0,
        sessions: [],
      };
      index.set(r.person_id, person);
      out.push(person);
    }
    person.talkCount += 1;
    if (r.agenda_published === 1) person.sessions.push(toGallerySession(r, timezone));
  }
  return out;
}

/**
 * One speaker's public page: who they are here, and where else they have spoken
 * in this install. The cross-event history carries only accepted and cancelled
 * talks at events that have published a program — a person's rejections are
 * never public, at any event, to anyone.
 */
export async function speakerPage(
  db: D1Database,
  eventId: string,
  personId: string
): Promise<SpeakerPage | null> {
  const [eventRes, personRes, hereRes, elsewhereRes] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT timezone, agenda_published FROM event WHERE id = ?').bind(eventId),
    db
      .prepare(
        `SELECT id AS person_id, name, sort_name, job_title, organisation, bio, pronouns, links,
                headshot_file_id
         FROM person WHERE id = ?`
      )
      .bind(personId),
    db
      .prepare(`${GALLERY_SQL} AND pa.person_id = ? ORDER BY s.starts_at, s.title`)
      .bind(eventId, personId),
    db
      .prepare(
        `SELECT s.id AS submission_id, s.title, s.state, s.public_slug, s.starts_at,
                e.id AS event_id, e.slug AS event_slug, e.name AS event_name, e.starts_on
         FROM participation pa
         JOIN submission s ON s.id = pa.submission_id
         JOIN event e ON e.id = s.event_id
         WHERE pa.person_id = ? AND s.event_id <> ? AND ${PUBLIC_STATES}
           AND e.agenda_published = 1
         ORDER BY e.starts_on DESC, s.starts_at, s.title`
      )
      .bind(personId, eventId),
  ]);

  const p = rowsOf<{
    person_id: string;
    name: string;
    sort_name: string | null;
    job_title: string | null;
    organisation: string | null;
    bio: string | null;
    pronouns: string | null;
    links: string | null;
    headshot_file_id: string | null;
  }>(personRes)[0];
  if (!p) return null;
  const ev = rowsOf<{ timezone: string; agenda_published: number }>(eventRes)[0];
  if (!ev) return null;

  const elsewhere = rowsOf<{
    submission_id: string;
    title: string;
    state: PublicState;
    public_slug: string | null;
    starts_at: number | null;
    event_id: string;
    event_slug: string;
    event_name: string;
    starts_on: string;
  }>(elsewhereRes).map((r) => ({
    submissionId: r.submission_id,
    eventId: r.event_id,
    eventSlug: r.event_slug,
    eventName: r.event_name,
    year: r.starts_on.slice(0, 4),
    title: r.title,
    state: r.state,
    publicSlug: r.public_slug,
    startsAt: r.starts_at,
  }));

  return {
    person: {
      personId: p.person_id,
      name: p.name,
      sortName: p.sort_name,
      jobTitle: p.job_title,
      organisation: p.organisation,
      bio: p.bio,
      pronouns: p.pronouns,
      links: p.links,
      headshotFileId: p.headshot_file_id,
      initials: initialsOf(p.name),
    },
    agendaPublished: ev.agenda_published === 1,
    sessions: rowsOf<GalleryRow>(hereRes)
      .filter((r) => r.agenda_published === 1)
      .map((r) => toGallerySession(r, ev.timezone)),
    elsewhere,
  };
}

const QUESTION_KINDS: readonly CfpQuestionKind[] = ['short', 'long', 'select', 'checkbox'];

/** R-10: the organizer's own questions, parsed and ordered, for the form. */
export async function cfpQuestions(db: D1Database, eventId: string): Promise<CfpQuestion[]> {
  const row = await db
    .prepare('SELECT questions FROM event WHERE id = ?')
    .bind(eventId)
    .first<{ questions: string }>();
  if (!row) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.questions);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: CfpQuestion[] = [];
  parsed.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null) return;
    const q = raw as Record<string, unknown>;
    const kind = q['kind'];
    if (typeof q['id'] !== 'string' || typeof q['label'] !== 'string') return;
    if (typeof kind !== 'string' || !QUESTION_KINDS.includes(kind as CfpQuestionKind)) return;
    const showIfRaw = q['showIf'];
    let showIf: CfpQuestion['showIf'] = null;
    if (typeof showIfRaw === 'object' && showIfRaw !== null) {
      const s = showIfRaw as Record<string, unknown>;
      if (typeof s['questionId'] === 'string' && typeof s['equals'] === 'string') {
        showIf = { questionId: s['questionId'], equals: s['equals'] };
      }
    }
    const options = Array.isArray(q['options'])
      ? (q['options'] as unknown[]).filter((o): o is string => typeof o === 'string')
      : null;
    out.push({
      id: q['id'],
      kind: kind as CfpQuestionKind,
      label: q['label'],
      hint: typeof q['hint'] === 'string' ? q['hint'] : null,
      required: q['required'] === true,
      options,
      showIf,
      position: typeof q['position'] === 'number' ? q['position'] : i + 1,
    });
  });
  return out.sort((a, b) => a.position - b.position);
}
