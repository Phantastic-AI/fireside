// The read side of a speaker's helper relationships (schema/0011): who helps
// them at this event, and — the other direction — which speaker's portal a
// signed-in person should see when they are nobody's own participant here.
//
// Ownership is written into every statement, the same discipline
// queries/portal.ts and workflows/portal-actions.ts already keep: a helper
// has standing on exactly the one speaker's tasks they were added against, at
// exactly the one event the relationship names — never on another speaker's,
// and never on the talk's own words.

export type Helper = {
  id: string;
  personId: string;
  name: string;
  email: string | null;
  addedAt: number;
};

type HelperRow = { id: string; person_id: string; name: string; email: string | null; added_at: number };

/** Who helps this speaker at this event, most recently added first — the
 *  list behind "People who help you" on the speaker's own portal. */
export async function helpersOfSpeaker(
  db: D1Database,
  eventId: string,
  speakerPersonId: string
): Promise<Helper[]> {
  const res = await db
    .prepare(
      // The name the speaker typed (sh.helper_name), never the person's own
      // stored name — so the readback discloses nothing about who the address
      // may already belong to. Email is the speaker's own input too.
      `SELECT sh.id, sh.helper_person_id AS person_id,
              COALESCE(sh.helper_name, 'Someone who helps you') AS name, p.email, sh.added_at
         FROM speaker_helper sh
         JOIN person p ON p.id = sh.helper_person_id
        WHERE sh.event_id = ? AND sh.speaker_person_id = ? AND sh.removed_at IS NULL
        ORDER BY sh.added_at DESC`
    )
    .bind(eventId, speakerPersonId)
    .all<HelperRow>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    personId: r.person_id,
    name: r.name,
    email: r.email,
    addedAt: r.added_at,
  }));
}

export type Helping = { speakerPersonId: string; speakerName: string };

/** The speaker(s) this signed-in person helps at this event — how
 *  routes/public/portal.ts finds the helper-scoped view for someone who is
 *  not themselves a participant here. */
export async function helpingAt(
  db: D1Database,
  eventId: string,
  helperPersonId: string
): Promise<Helping[]> {
  const res = await db
    .prepare(
      `SELECT sh.speaker_person_id, p.name AS speaker_name
         FROM speaker_helper sh
         JOIN person p ON p.id = sh.speaker_person_id
        WHERE sh.event_id = ? AND sh.helper_person_id = ? AND sh.removed_at IS NULL
        ORDER BY sh.added_at`
    )
    .bind(eventId, helperPersonId)
    .all<{ speaker_person_id: string; speaker_name: string }>();
  return (res.results ?? []).map((r) => ({
    speakerPersonId: r.speaker_person_id,
    speakerName: r.speaker_name,
  }));
}

/**
 * Who a task write should act as: the task's own owner, when the caller
 * either owns it themselves or is an active helper of the person who does.
 * Null means neither is true, and the caller's route should treat the write
 * exactly as it would a wrong or stale task id — 'moved', never a stack
 * trace, and never a write against a task that is not the caller's to touch.
 */
export async function taskActorId(
  db: D1Database,
  taskId: string,
  principalPersonId: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT t.person_id FROM task t
        WHERE t.id = ?1
          AND (t.person_id = ?2
               OR EXISTS (SELECT 1 FROM speaker_helper sh
                           WHERE sh.event_id = t.event_id AND sh.speaker_person_id = t.person_id
                             AND sh.helper_person_id = ?2 AND sh.removed_at IS NULL))`
    )
    .bind(taskId, principalPersonId)
    .first<{ person_id: string }>();
  return row?.person_id ?? null;
}

/**
 * A speaker's active helpers, by contact only. Meant for workflows/files.ts's
 * reminder senders (askAgain, askEveryoneWaiting) to CC alongside the
 * speaker, so a helper stays as caught up on outstanding deliverables as the
 * speaker they help — CNT-08's reminder is a message, sent to everyone
 * carrying the obligation, not only its owner. Not yet wired in: those two
 * functions live in workflows/files.ts, outside this parcel's edit scope. See
 * the build log for the small patch that plugs this in.
 */
export async function helperContactsFor(
  db: D1Database,
  eventId: string,
  speakerPersonId: string
): Promise<{ name: string; email: string | null }[]> {
  const res = await db
    .prepare(
      `SELECT p.name, p.email
         FROM speaker_helper sh
         JOIN person p ON p.id = sh.helper_person_id
        WHERE sh.event_id = ? AND sh.speaker_person_id = ? AND sh.removed_at IS NULL`
    )
    .bind(eventId, speakerPersonId)
    .all<{ name: string; email: string | null }>();
  return res.results ?? [];
}
