// Δ conn — the exchange's read path: find someone by name, see who has asked
// to connect, and read the friends you already have.
//
// The same law as queries/social.ts, restated because this is a second read
// path onto the same person row: the name is always visible; work (which carries
// organisation, same bundle share_contact has always used), links and email
// are three separate yeses, each read live off person.share_contact at the
// moment of the read — never cached, never stored on the friend_request row
// itself, so tightening an opt-in after the fact tightens every friend's view
// of you on their very next page load.
//
// Search is deliberately not a roster. The operator's own framing was "can't
// people just exchange names" — you already know who you are looking for
// from the hallway, so the pool is people using this event's schedule
// (my_schedule exists) and the match is their name, not a public list of
// attendees. A blank or one-character query returns nothing rather than
// everyone.

import { initialsOf } from './public';
import { parseContact, socialView, VISIBLE_SESSION, type ContactOptIns } from './social';

function rowsOf<T>(res: D1Result<Record<string, unknown>> | undefined): T[] {
  return (res?.results ?? []) as unknown as T[];
}

/** Escape SQL LIKE metacharacters in a user-typed query, '\' as the escape char. */
function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export type FriendStatus = 'none' | 'pending_out' | 'pending_in' | 'friends';

export type AttendeeMatch = {
  personId: string;
  name: string;
  initials: string;
  headshotFileId: string | null;
  /** Disambiguation only, and only ever a fact the searcher can already see
   *  through the reciprocal room layer (queries/social.ts's socialView) — a
   *  name search never surfaces a "going to" that reciprocity itself would
   *  not have shown. Organisation is never shown here at all: it is opt-in,
   *  same as links and email, and a search result is read before any accept. */
  goingTo: { title: string; publicSlug: string | null } | null;
  status: FriendStatus;
};

export type IncomingFriendRequest = {
  personId: string;
  name: string;
  initials: string;
  headshotFileId: string | null;
  requestedAt: number;
};

export type MyFriend = {
  personId: string;
  name: string;
  initials: string;
  headshotFileId: string | null;
  /** Each null unless the friend opted that fact in — parseContact, read live. */
  jobTitle: string | null;
  organisation: string | null;
  links: string | null;
  email: string | null;
  friendedAt: number;
};

type LiveRequestRow = {
  requester_id: string;
  recipient_id: string;
  accepted_at: number | null;
  requested_at: number;
};

/** Every live (non-revoked) friend_request touching me, in either direction —
 *  one read, reused for the search page's status chips, the incoming list,
 *  and the friends list, so a page never round-trips three times for one
 *  small, already-fully-scoped fact. */
async function liveRequests(db: D1Database, eventId: string, meId: string): Promise<LiveRequestRow[]> {
  const res = await db
    .prepare(
      `SELECT requester_id, recipient_id, accepted_at, requested_at
         FROM friend_request
        WHERE event_id = ? AND revoked_at IS NULL AND (requester_id = ? OR recipient_id = ?)`
    )
    .bind(eventId, meId, meId)
    .all<LiveRequestRow>();
  return res.results;
}

function statusFor(rows: LiveRequestRow[], meId: string, otherId: string): FriendStatus {
  const row = rows.find((r) => r.requester_id === otherId || r.recipient_id === otherId);
  if (!row) return 'none';
  if (row.accepted_at) return 'friends';
  return row.requester_id === meId ? 'pending_out' : 'pending_in';
}

/**
 * Find another attendee by name. The pool is people who have used this
 * event's schedule (a my_schedule row exists) — not a public directory. A
 * query under two characters returns nothing: there is no browsing mode.
 */
export async function searchAttendees(
  db: D1Database,
  eventId: string,
  meId: string,
  q: string
): Promise<AttendeeMatch[]> {
  const term = q.trim();
  if (term.length < 2) return [];

  const [matchRes, mine, requests] = await Promise.all([
    db
      .prepare(
        `SELECT DISTINCT pe.id AS person_id, pe.name, pe.headshot_file_id
           FROM person pe
           JOIN my_schedule ms ON ms.person_id = pe.id AND ms.event_id = ?
          WHERE pe.id <> ? AND pe.name LIKE ? ESCAPE '\\'
          ORDER BY pe.name
          LIMIT 20`
      )
      .bind(eventId, meId, likeTerm(term))
      .all<{ person_id: string; name: string; headshot_file_id: string | null }>(),
    socialView(db, eventId, meId),
    liveRequests(db, eventId, meId),
  ]);

  // A person already visible through the reciprocal room layer carries the
  // one session title that layer already shows — never a session the
  // searcher could not already see there.
  const goingTo = new Map<string, { title: string; publicSlug: string | null }>();
  for (const p of mine.people) {
    const first = p.sessions[0];
    if (first) goingTo.set(p.personId, { title: first.title, publicSlug: first.publicSlug });
  }

  return rowsOf<{ person_id: string; name: string; headshot_file_id: string | null }>(matchRes).map((r) => ({
    personId: r.person_id,
    name: r.name,
    initials: initialsOf(r.name),
    headshotFileId: r.headshot_file_id,
    goingTo: goingTo.get(r.person_id) ?? null,
    status: statusFor(requests, meId, r.person_id),
  }));
}

/** Requests addressed to me, oldest first — "X would like to connect" reads
 *  top to bottom in the order they arrived. */
export async function incomingFriendRequests(
  db: D1Database,
  eventId: string,
  meId: string
): Promise<IncomingFriendRequest[]> {
  const res = await db
    .prepare(
      `SELECT pe.id AS person_id, pe.name, pe.headshot_file_id, fr.requested_at
         FROM friend_request fr
         JOIN person pe ON pe.id = fr.requester_id
        WHERE fr.event_id = ? AND fr.recipient_id = ? AND fr.accepted_at IS NULL AND fr.revoked_at IS NULL
        ORDER BY fr.requested_at`
    )
    .bind(eventId, meId)
    .all<{ person_id: string; name: string; headshot_file_id: string | null; requested_at: number }>();
  return rowsOf<{ person_id: string; name: string; headshot_file_id: string | null; requested_at: number }>(
    res
  ).map((r) => ({
    personId: r.person_id,
    name: r.name,
    initials: initialsOf(r.name),
    headshotFileId: r.headshot_file_id,
    requestedAt: r.requested_at,
  }));
}

type FriendRow = {
  person_id: string;
  name: string;
  headshot_file_id: string | null;
  job_title: string | null;
  organisation: string | null;
  links: string | null;
  email: string | null;
  share_contact: string;
  accepted_at: number;
};

/** "Your people" — every mutual accept, most recent first, each field gated
 *  by that friend's own opt-ins at read time (never at accept time). */
export async function myFriends(db: D1Database, eventId: string, meId: string): Promise<MyFriend[]> {
  const res = await db
    .prepare(
      `SELECT pe.id AS person_id, pe.name, pe.headshot_file_id, pe.job_title, pe.organisation,
              pe.links, pe.email, pe.share_contact, fr.accepted_at
         FROM friend_request fr
         JOIN person pe ON pe.id = CASE WHEN fr.requester_id = ? THEN fr.recipient_id ELSE fr.requester_id END
        WHERE fr.event_id = ? AND fr.revoked_at IS NULL AND fr.accepted_at IS NOT NULL
          AND (fr.requester_id = ? OR fr.recipient_id = ?)
        ORDER BY fr.accepted_at DESC`
    )
    .bind(meId, eventId, meId, meId)
    .all<FriendRow>();
  return rowsOf<FriendRow>(res).map((r) => {
    const opts: ContactOptIns = parseContact(r.share_contact);
    return {
      personId: r.person_id,
      name: r.name,
      initials: initialsOf(r.name),
      headshotFileId: r.headshot_file_id,
      jobTitle: opts.work ? r.job_title : null,
      organisation: opts.work ? r.organisation : null,
      links: opts.links ? r.links : null,
      email: opts.email ? r.email : null,
      friendedAt: r.accepted_at,
    };
  });
}

/** True iff meId and otherId hold a live, mutual accept for this event —
 *  the one gate the friend-schedule route trusts. */
export async function isFriend(db: D1Database, eventId: string, meId: string, otherId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM friend_request
        WHERE event_id = ? AND accepted_at IS NOT NULL AND revoked_at IS NULL
          AND ((requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?))`
    )
    .bind(eventId, meId, otherId, otherId, meId)
    .first();
  return row !== null;
}

export type FriendSession = {
  submissionId: string;
  publicSlug: string | null;
  title: string;
  startsAt: number;
  roomName: string | null;
  format: string;
  cancelled: boolean;
};

/**
 * A friend's schedule: every publicly-visible session they starred, in
 * order. Gated on the friendship alone — becoming friends is the agreement
 * to share the schedule (D-conn), which is a separate fact from any contact
 * opt-in and from the room-reciprocity share_enabled switch (queries/
 * social.ts's socialView): a friend sees the picks whether or not "who else
 * is going" sharing is on, because the friendship is its own consent.
 * Returns null when the two are not friends, so the route can 404 rather
 * than render an empty list that looks like "nobody starred anything".
 */
export async function friendSchedule(
  db: D1Database,
  eventId: string,
  meId: string,
  friendId: string
): Promise<{ name: string; sessions: FriendSession[] } | null> {
  if (!(await isFriend(db, eventId, meId, friendId))) return null;

  const person = await db.prepare('SELECT name FROM person WHERE id = ?').bind(friendId).first<{ name: string }>();
  if (!person) return null;

  const res = await db
    .prepare(
      `SELECT s.id AS submission_id, s.public_slug, s.title, s.starts_at, s.format, s.state,
              r.name AS room_name
         FROM star st
         JOIN my_schedule ms ON ms.id = st.my_schedule_id
         JOIN submission s ON s.id = st.submission_id
         JOIN event e ON e.id = s.event_id
         LEFT JOIN room r ON r.id = s.room_id
        WHERE ms.person_id = ? AND ms.event_id = ? AND ${VISIBLE_SESSION}
        ORDER BY s.starts_at`
    )
    .bind(friendId, eventId)
    .all<{
      submission_id: string;
      public_slug: string | null;
      title: string;
      starts_at: number;
      format: string;
      state: 'accepted' | 'cancelled';
      room_name: string | null;
    }>();

  return {
    name: person.name,
    sessions: rowsOf<{
      submission_id: string;
      public_slug: string | null;
      title: string;
      starts_at: number;
      format: string;
      state: 'accepted' | 'cancelled';
      room_name: string | null;
    }>(res).map((r) => ({
      submissionId: r.submission_id,
      publicSlug: r.public_slug,
      title: r.title,
      startsAt: r.starts_at,
      roomName: r.room_name,
      format: r.format,
      cancelled: r.state === 'cancelled',
    })),
  };
}
