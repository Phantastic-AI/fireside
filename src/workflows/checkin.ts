// T611 — the check-in facts, one module: links minted by name, marks read
// back as "who and when". The routes (the volunteer sheet, the green room)
// and the agent boundary all call these; none keeps its own copy.

import { newId, now } from '../lib/db';


export type CheckinLinkRow = { id: string; name: string; nonce: string; revokedAt: number | null };

export async function checkinLinks(db: D1Database, eventId: string): Promise<CheckinLinkRow[]> {
  const res = await db
    .prepare(
      `SELECT id, name, nonce, revoked_at FROM checkin_link
        WHERE event_id = ? ORDER BY created_at`
    )
    .bind(eventId)
    .all<{ id: string; name: string; nonce: string; revoked_at: number | null }>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    nonce: r.nonce,
    revokedAt: r.revoked_at,
  }));
}

export async function mintCheckinLink(
  db: D1Database,
  eventId: string,
  name: string
): Promise<string | null> {
  const clean = name.trim().slice(0, 60);
  if (!clean) return null;
  const nonce = `ci-${crypto.randomUUID().replace(/-/g, '')}`;
  await db
    .prepare(
      `INSERT INTO checkin_link (id, event_id, name, nonce, created_at)
       VALUES (?,?,?,?,?)`
    )
    .bind(newId('cil'), eventId, clean, nonce, now())
    .run();
  return nonce;
}

export async function revokeCheckinLink(db: D1Database, eventId: string, id: string): Promise<void> {
  await db
    .prepare('UPDATE checkin_link SET revoked_at = ? WHERE id = ? AND event_id = ?')
    .bind(now(), id, eventId)
    .run();
}

/** Every arrival at this event, keyed by session, said as "09:42 · Sam" —
 *  the green room's own read (both doors), one query. */
export async function arrivalsFor(
  db: D1Database,
  eventId: string,
  timezone: string
): Promise<Map<string, { at: string; who: string }>> {
  const res = await db
    .prepare(
      `SELECT ci.submission_id, ci.marked_at, cl.name AS who
         FROM checkin ci JOIN checkin_link cl ON cl.id = ci.link_id
         JOIN submission s ON s.id = ci.submission_id
        WHERE s.event_id = ?`
    )
    .bind(eventId)
    .all<{ submission_id: string; marked_at: number; who: string }>();
  const t = (ms: number): string =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  return new Map(
    (res.results ?? []).map((r) => [r.submission_id, { at: t(r.marked_at), who: r.who }])
  );
}
