// The read side of following a speaker (schema/0013): whether this person
// follows that speaker, and the whole private list of speakers they follow.
//
// A follow is the follower's own list and nothing else. There is no read here
// that hands a speaker, or anyone, the identities of who follows them — that
// stays private by construction, the same posture the star list keeps. When a
// followed speaker's cross-conference reach lands (step 3), it will be gated
// by the organizer's own opt-in, not by exposing this list.

export type FollowedSpeaker = { personId: string; name: string };

/** Does this follower follow this speaker right now? */
export async function isFollowingSpeaker(
  db: D1Database,
  followerPersonId: string,
  speakerPersonId: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM speaker_follow
        WHERE follower_person_id = ? AND speaker_person_id = ? AND unfollowed_at IS NULL`
    )
    .bind(followerPersonId, speakerPersonId)
    .first();
  return row !== null;
}

/** The speakers this person follows, most recently followed first — the list
 *  behind a future "speakers you follow" view. */
export async function followedSpeakers(
  db: D1Database,
  followerPersonId: string
): Promise<FollowedSpeaker[]> {
  const res = await db
    .prepare(
      `SELECT p.id AS person_id, p.name AS name
         FROM speaker_follow sf
         JOIN person p ON p.id = sf.speaker_person_id
        WHERE sf.follower_person_id = ? AND sf.unfollowed_at IS NULL
        ORDER BY sf.created_at DESC`
    )
    .bind(followerPersonId)
    .all<{ person_id: string; name: string }>();
  return (res.results ?? []).map((r) => ({ personId: r.person_id, name: r.name }));
}
