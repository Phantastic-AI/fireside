// Δ12 — the audience's own read path: what I am going to, who else is going,
// and the people I have already meant to find.
//
// Dani's screen, and the shape of this file follows one rule from 02 §1.21:
// the name is always visible, and every other fact about a person — where they
// work, their links, their address — is a separate opt-in they made themselves.
// So the gating happens HERE, in the projection, not at render time: a field
// nobody opted into arrives as null and no screen can leak it by forgetting.
//
// The second rule is reciprocity, and it is a live join rather than a stored
// list. `peopleToFind` re-checks share_enabled on BOTH my_schedule rows and
// shared_at on BOTH stars, every read. That is what makes turning sharing off
// instant: there is no cached audience to invalidate, the row simply stops
// satisfying the join.
//
// No Principal type crosses this seam — the caller passes the person id it
// already proved, and every statement carries it in the WHERE clause.

import { initialsOf } from './public';

/* ------------------------------------------------------------------ *
 * The visibility rule, written once.
 * ------------------------------------------------------------------ */

/**
 * A star may only ever name a session a stranger could already see. The rule is
 * the public agenda rule of queries/public.ts, restated (that const is private
 * there): accepted-or-cancelled, placed, on a published agenda. Restating it
 * costs one comment; skipping it would let a shared list print the title of a
 * talk the committee has not announced.
 */
const VISIBLE_SESSION = `
  s.state IN ('accepted','cancelled') AND s.starts_at IS NOT NULL AND e.agenda_published = 1`;

/* ------------------------------------------------------------------ *
 * DTOs
 * ------------------------------------------------------------------ */

/** person.share_contact, parsed. All three default to off — an absent key,
 *  an empty object and a corrupt string all mean "they never said yes". */
export type ContactOptIns = { work: boolean; links: boolean; email: boolean };

export type MyScheduleView = {
  /** Null until their first write — the row is created lazily (workflows/social.ts). */
  scheduleId: string | null;
  shareEnabled: boolean;
  /** Submission ids they have starred here, in starring order. */
  starred: string[];
  contact: ContactOptIns;
  // Their own three facts, ungated: the opt-in screen has to be able to show a
  // person exactly what saying yes would put in front of a stranger.
  jobTitle: string | null;
  organisation: string | null;
  links: string | null;
  email: string | null;
};

export type SharedSession = {
  submissionId: string;
  title: string;
  publicSlug: string | null;
  startsAt: number | null;
  /** True when this person + this session is already in your connections. */
  noted: boolean;
};

export type PersonToFind = {
  personId: string;
  name: string;
  initials: string;
  /** Each of these is null unless they opted that fact in. */
  jobTitle: string | null;
  organisation: string | null;
  links: string | null;
  email: string | null;
  /** The sessions you both shared — the whole reason they are on the list. */
  sessions: SharedSession[];
};

export type MyConnection = {
  otherPersonId: string;
  name: string;
  initials: string;
  submissionId: string;
  title: string;
  publicSlug: string | null;
  note: string | null;
  createdAt: number;
};

export type SocialView = {
  mine: MyScheduleView;
  people: PersonToFind[];
  connections: MyConnection[];
};

/* ------------------------------------------------------------------ *
 * Row shapes
 * ------------------------------------------------------------------ */

type MineRow = {
  share_contact: string;
  schedule_id: string | null;
  share_enabled: number;
  job_title: string | null;
  organisation: string | null;
  links: string | null;
  email: string | null;
};
type StarRow = { submission_id: string };
type FindRow = {
  person_id: string;
  name: string;
  job_title: string | null;
  organisation: string | null;
  links: string | null;
  email: string | null;
  share_contact: string;
  submission_id: string;
  title: string;
  public_slug: string | null;
  starts_at: number | null;
};
type ConnectionRow = {
  other_person_id: string;
  name: string;
  submission_id: string;
  title: string;
  public_slug: string | null;
  note: string | null;
  created_at: number;
};

function rowsOf<T>(res: D1Result<Record<string, unknown>> | undefined): T[] {
  return (res?.results ?? []) as unknown as T[];
}

/** Parse person.share_contact. Anything unparseable is read as all-off, which
 *  is the safe direction: a broken opt-in never becomes an accidental yes. */
export function parseContact(raw: string | null | undefined): ContactOptIns {
  const off: ContactOptIns = { work: false, links: false, email: false };
  if (!raw) return off;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null) return off;
    return { work: v['work'] === true, links: v['links'] === true, email: v['email'] === true };
  } catch {
    return off;
  }
}

/* ------------------------------------------------------------------ *
 * The reciprocity join
 * ------------------------------------------------------------------ */

// Read it as one sentence: from MY schedule at this event, which I have chosen
// to share, take the stars I have shared; find other people's stars on the same
// session; keep the ones whose owner is also sharing, and whose star is also
// shared. Six conditions, all re-checked on every read, symmetrical on purpose.
const PEOPLE_TO_FIND = `
  SELECT other.person_id AS person_id, pe.name, pe.job_title, pe.organisation,
         pe.links, pe.email, pe.share_contact,
         s.id AS submission_id, s.title, s.public_slug, s.starts_at
    FROM my_schedule ms
    JOIN star mine        ON mine.my_schedule_id = ms.id AND mine.shared_at IS NOT NULL
    JOIN star theirs      ON theirs.submission_id = mine.submission_id
                         AND theirs.my_schedule_id <> ms.id
                         AND theirs.shared_at IS NOT NULL
    JOIN my_schedule other ON other.id = theirs.my_schedule_id
                         AND other.event_id = ms.event_id
                         AND other.share_enabled = 1
                         AND other.person_id <> ms.person_id
    JOIN person pe        ON pe.id = other.person_id
    JOIN submission s     ON s.id = mine.submission_id
    JOIN event e          ON e.id = s.event_id
   WHERE ms.person_id = ? AND ms.event_id = ? AND ms.share_enabled = 1
     AND ${VISIBLE_SESSION}
   ORDER BY pe.name, s.starts_at, s.title`;

/**
 * One person's whole social view of one event: their own list, the people whose
 * shared list overlaps theirs, and the connections they have already noted.
 *
 * Four statements, one round trip. When they have never starred anything here,
 * `mine.scheduleId` is null and the other two lists are empty — the caller
 * renders the door, not a zero.
 */
export async function socialView(
  db: D1Database,
  eventId: string,
  personId: string
): Promise<SocialView> {
  const [mineRes, starRes, findRes, connRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT pe.share_contact, pe.job_title, pe.organisation, pe.links, pe.email,
                ms.id AS schedule_id, COALESCE(ms.share_enabled, 0) AS share_enabled
           FROM person pe
           LEFT JOIN my_schedule ms ON ms.person_id = pe.id AND ms.event_id = ?
          WHERE pe.id = ?`
      )
      .bind(eventId, personId),
    db
      .prepare(
        `SELECT st.submission_id
           FROM star st
           JOIN my_schedule ms ON ms.id = st.my_schedule_id
          WHERE ms.person_id = ? AND ms.event_id = ?
          ORDER BY st.starred_at, st.id`
      )
      .bind(personId, eventId),
    db.prepare(PEOPLE_TO_FIND).bind(personId, eventId),
    db
      .prepare(
        `SELECT c.other_person_id, pe.name, c.submission_id, s.title, s.public_slug,
                c.note, c.created_at
           FROM connection c
           JOIN person pe ON pe.id = c.other_person_id
           JOIN submission s ON s.id = c.submission_id
          WHERE c.owner_person_id = ? AND s.event_id = ?
          ORDER BY c.created_at DESC`
      )
      .bind(personId, eventId),
  ]);

  const mineRow = rowsOf<MineRow>(mineRes)[0];
  const connections: MyConnection[] = rowsOf<ConnectionRow>(connRes).map((r) => ({
    otherPersonId: r.other_person_id,
    name: r.name,
    initials: initialsOf(r.name),
    submissionId: r.submission_id,
    title: r.title,
    publicSlug: r.public_slug,
    note: r.note,
    createdAt: r.created_at,
  }));
  const noted = new Set(connections.map((c) => `${c.otherPersonId}|${c.submissionId}`));

  const people: PersonToFind[] = [];
  const index = new Map<string, PersonToFind>();
  for (const r of rowsOf<FindRow>(findRes)) {
    let person = index.get(r.person_id);
    if (!person) {
      const opts = parseContact(r.share_contact);
      person = {
        personId: r.person_id,
        name: r.name,
        initials: initialsOf(r.name),
        jobTitle: opts.work ? r.job_title : null,
        organisation: opts.work ? r.organisation : null,
        links: opts.links ? r.links : null,
        email: opts.email ? r.email : null,
        sessions: [],
      };
      index.set(r.person_id, person);
      people.push(person);
    }
    person.sessions.push({
      submissionId: r.submission_id,
      title: r.title,
      publicSlug: r.public_slug,
      startsAt: r.starts_at,
      noted: noted.has(`${r.person_id}|${r.submission_id}`),
    });
  }

  return {
    mine: {
      scheduleId: mineRow?.schedule_id ?? null,
      shareEnabled: (mineRow?.share_enabled ?? 0) === 1,
      starred: rowsOf<StarRow>(starRes).map((r) => r.submission_id),
      contact: parseContact(mineRow?.share_contact),
      jobTitle: mineRow?.job_title ?? null,
      organisation: mineRow?.organisation ?? null,
      links: mineRow?.links ?? null,
      email: mineRow?.email ?? null,
    },
    people,
    connections,
  };
}
