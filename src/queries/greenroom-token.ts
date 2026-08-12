// R-4 — the one query in this build that authenticates by a bearer token
// instead of a Principal. The green room's public mount (/gr/:nonce, S-17)
// trades a sign-in for a share link: rotating event.green_room_nonce is the
// entire revocation model, so this reads by nonce and nothing else. An
// unknown or empty nonce returns null and the route falls through to its
// own 404 — this function never distinguishes "wrong token" from "no such
// event" for the caller, on purpose.

export type GreenRoomTokenEvent = { id: string; slug: string; name: string };

export async function eventByGreenRoomNonce(
  db: D1Database,
  nonce: string
): Promise<GreenRoomTokenEvent | null> {
  const trimmed = nonce.trim();
  if (!trimmed) return null;
  return await db
    .prepare('SELECT id, slug, name FROM event WHERE green_room_nonce = ?')
    .bind(trimmed)
    .first<GreenRoomTokenEvent>();
}
