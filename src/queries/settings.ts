// The settings read path — one query, everything S-20 shows.
//
// Scope is the chokepoint's job, not the template's (08 §1): this reads
// behind requireScope(EDIT_ROLES), and the team section carries its own
// narrower fact (`mayTouchTeam`) so the screen never offers a control the
// writer would refuse. Install-wide organizers pass both, as everywhere.
//
// The questions come back through cfpQuestions — the same reader the public
// call uses — so the editor cannot show a question the form would drop. What
// it drops is counted (`unreadable`) rather than hidden, and the raw stored
// text rides along so a save can refuse to clobber somebody else's edit.

import type { Principal } from '../workflows/account';
import { requireScope, EDIT_ROLES } from './admin';
import { cfpQuestions, type CfpQuestion } from './public';

/** Touching another person's standing is the owner's own act (D-026). */
export const TEAM_ROLES: readonly string[] = ['owner'];

export type EventRole = 'owner' | 'approver' | 'editor' | 'viewer';

export const EVENT_ROLES: readonly EventRole[] = ['owner', 'approver', 'editor', 'viewer'];

export function isEventRole(value: string): value is EventRole {
  return (EVENT_ROLES as readonly string[]).includes(value);
}

export type TeamMember = {
  personId: string;
  name: string;
  email: string | null;
  role: EventRole;
  grantedAt: number;
  /** The reader's own row, so the screen can say so before they remove it. */
  isYou: boolean;
};

/** A question, plus how many proposals already answered it. */
export type SettingsQuestion = CfpQuestion & { answered: number };

/** AIA-02: a room, as the settings screen lists it. No delete — see workflows/settings.ts. */
export type SettingsRoom = {
  id: string;
  name: string;
  capacity: number | null;
  position: number;
};

/** AIA-02: a track, as the settings screen lists it. Colour comes from the
 *  same creation wheel a new event is painted with. */
export type SettingsTrack = {
  id: string;
  name: string;
  slug: string;
  colour: string;
  position: number;
};

export type EventSettings = {
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
  cfpIntro: string | null;
  cfpOpensAt: number | null;
  cfpClosesAt: number | null;
  decideBy: string | null;
  maxSubmissions: number;
  agendaPublished: boolean;
  greenRoomNonce: string | null;
  questions: SettingsQuestion[];
  questionCount: number;
  /** Questions stored but not readable — shown as a count, never swallowed. */
  unreadable: number;
  /** The stored text exactly as it stands, carried into the save as a guard. */
  questionsRaw: string;
  team: TeamMember[];
  teamCount: number;
  ownerCount: number;
  rooms: SettingsRoom[];
  tracks: SettingsTrack[];
  proposalCount: number;
  /** The reader's own standing here: 'organizer' install-wide, or their role. */
  standing: string;
  mayTouchTeam: boolean;
};

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
  cfp_intro: string | null;
  cfp_opens_at: number | null;
  cfp_closes_at: number | null;
  decide_by: string | null;
  max_submissions: number;
  agenda_published: number;
  green_room_nonce: string | null;
  questions: string;
};

type TeamRow = {
  person_id: string;
  name: string;
  email: string | null;
  role: EventRole;
  granted_at: number;
};

function rowsOf<T>(res: D1Result<Record<string, unknown>> | undefined): T[] {
  return (res?.results ?? []) as unknown as T[];
}

/** How many entries the stored text actually holds, readable or not. */
function storedCount(raw: string): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** The id behind a slug — all a writer needs before its own scope check. */
export async function eventIdBySlug(db: D1Database, slug: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT id FROM event WHERE slug = ?')
    .bind(slug)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * Everything the settings screen shows. Null when there is no such
 * conference; ScopeError when it is not this person's to change.
 */
export async function eventSettings(
  db: D1Database,
  principal: Principal,
  slug: string
): Promise<EventSettings | null> {
  const ev = await db
    .prepare(
      `SELECT id, slug, name, tagline, starts_on, ends_on, timezone, tz_label, venue_name,
              venue_address, cfp_intro, cfp_opens_at, cfp_closes_at, decide_by, max_submissions,
              agenda_published, green_room_nonce, questions
       FROM event WHERE slug = ?`
    )
    .bind(slug)
    .first<EventRow>();
  if (!ev) return null;

  requireScope(principal, ev.id, EDIT_ROLES);

  const [questions, res] = await Promise.all([
    cfpQuestions(db, ev.id),
    db.batch<Record<string, unknown>>([
      db
        .prepare(
          `SELECT r.person_id, p.name, p.email, r.role, r.granted_at
           FROM event_role r JOIN person p ON p.id = r.person_id
           WHERE r.event_id = ?
           ORDER BY CASE r.role WHEN 'owner' THEN 0 WHEN 'approver' THEN 1
                                WHEN 'editor' THEN 2 ELSE 3 END, p.name`
        )
        .bind(ev.id),
      // Answers already given, counted per question. The CASE keeps a
      // malformed answer set from taking the whole screen down with it.
      db
        .prepare(
          `SELECT je.key AS k, COUNT(*) AS n
           FROM submission s,
                json_each(CASE WHEN json_valid(s.extra) THEN s.extra ELSE '{}' END) je
           WHERE s.event_id = ?
           GROUP BY je.key`
        )
        .bind(ev.id),
      db
        .prepare("SELECT COUNT(*) AS n FROM submission WHERE event_id = ? AND state <> 'draft'")
        .bind(ev.id),
      db
        .prepare('SELECT id, name, capacity, position FROM room WHERE event_id = ? ORDER BY position, name')
        .bind(ev.id),
      db
        .prepare('SELECT id, name, slug, colour, position FROM track WHERE event_id = ? ORDER BY position, name')
        .bind(ev.id),
    ]),
  ]);

  const answered = new Map<string, number>();
  for (const r of rowsOf<{ k: string; n: number }>(res[1])) answered.set(r.k, r.n);

  const team = rowsOf<TeamRow>(res[0]).map((r) => ({
    personId: r.person_id,
    name: r.name,
    email: r.email,
    role: r.role,
    grantedAt: r.granted_at,
    isYou: r.person_id === principal.personId,
  }));

  const standing =
    principal.role === 'organizer' ? 'organizer' : (principal.eventRoles[ev.id] ?? 'viewer');

  return {
    id: ev.id,
    slug: ev.slug,
    name: ev.name,
    tagline: ev.tagline,
    startsOn: ev.starts_on,
    endsOn: ev.ends_on,
    timezone: ev.timezone,
    tzLabel: ev.tz_label,
    venueName: ev.venue_name,
    venueAddress: ev.venue_address,
    cfpIntro: ev.cfp_intro,
    cfpOpensAt: ev.cfp_opens_at,
    cfpClosesAt: ev.cfp_closes_at,
    decideBy: ev.decide_by,
    maxSubmissions: ev.max_submissions,
    agendaPublished: ev.agenda_published === 1,
    greenRoomNonce: ev.green_room_nonce,
    questions: questions.map((q) => ({ ...q, answered: answered.get(q.id) ?? 0 })),
    questionCount: questions.length,
    unreadable: Math.max(0, storedCount(ev.questions) - questions.length),
    questionsRaw: ev.questions,
    team,
    teamCount: team.length,
    ownerCount: team.filter((m) => m.role === 'owner').length,
    rooms: rowsOf<{ id: string; name: string; capacity: number | null; position: number }>(res[3]).map(
      (r) => ({ id: r.id, name: r.name, capacity: r.capacity, position: r.position })
    ),
    tracks: rowsOf<{ id: string; name: string; slug: string; colour: string; position: number }>(
      res[4]
    ).map((t) => ({ id: t.id, name: t.name, slug: t.slug, colour: t.colour, position: t.position })),
    proposalCount: rowsOf<{ n: number }>(res[2])[0]?.n ?? 0,
    standing,
    mayTouchTeam: principal.role === 'organizer' || principal.eventRoles[ev.id] === 'owner',
  };
}
