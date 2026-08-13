// Accounts: sign-up (create or claim), password sign-in, magic links, Google.
// A seeded speaker "signing up" claims their existing Person row — that is the
// organizer-added-you-to-the-roster flow, not a duplicate.
import { hashPassword, verifyPassword, signToken, verifyToken, randomNonce } from '../lib/sign';
import { newId } from '../lib/db';

export type PersonRow = {
  id: string;
  email: string | null;
  name: string;
  internal_role: 'organizer' | 'reviewer' | null;
  password_hash: string | null;
};

const norm = (email: string) => email.trim().toLowerCase();

export async function findPersonByEmail(db: D1Database, email: string): Promise<PersonRow | null> {
  return await db
    .prepare('SELECT id, email, name, internal_role, password_hash FROM person WHERE email = ?')
    .bind(norm(email))
    .first<PersonRow>();
}

export async function signUp(
  db: D1Database,
  input: { name: string; email: string; password: string }
): Promise<{ ok: true; personId: string } | { ok: false; error: string }> {
  const email = norm(input.email);
  if (!input.name.trim()) return { ok: false, error: 'A name is needed — it goes on programs.' };
  if (input.password.length < 8) return { ok: false, error: 'Passwords need at least eight characters.' };
  const existing = await findPersonByEmail(db, email);
  const hash = await hashPassword(input.password);
  if (existing) {
    if (existing.password_hash) {
      return { ok: false, error: 'That address already has an account. Sign in instead.' };
    }
    await db
      .prepare('UPDATE person SET password_hash = ?, last_signed_in_at = ? WHERE id = ?')
      .bind(hash, Date.now(), existing.id)
      .run();
    return { ok: true, personId: existing.id };
  }
  const id = newId('per');
  await db
    .prepare(
      'INSERT INTO person (id, email, name, sort_name, password_hash, share_contact, created_at, last_signed_in_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .bind(id, email, input.name.trim(), input.name.trim(), hash, '{}', Date.now(), Date.now())
    .run();
  return { ok: true, personId: id };
}

export async function signIn(
  db: D1Database,
  email: string,
  password: string
): Promise<PersonRow | null> {
  const person = await findPersonByEmail(db, email);
  if (!person?.password_hash) return null;
  const ok = await verifyPassword(password, person.password_hash);
  if (!ok) return null;
  await db.prepare('UPDATE person SET last_signed_in_at = ? WHERE id = ?').bind(Date.now(), person.id).run();
  return person;
}

// ---------- sessions ----------

const SESSION_DAYS = 7;

export async function sessionCookie(secret: string, personId: string): Promise<string> {
  const token = await signToken(secret, {
    purpose: 'session',
    subjectId: personId,
    nonce: randomNonce(),
    exp: Date.now() + SESSION_DAYS * 86_400_000,
  });
  return `fs_s=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export const clearSessionCookie = 'fs_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

export type Principal = {
  personId: string;
  name: string;
  email: string | null;
  role: 'organizer' | 'reviewer' | null; // install-wide standing
  eventRoles: Record<string, string>; // event_id -> owner|approver|editor|viewer
};

/** The person-plus-roles lookup every Principal is built from, however the
 *  caller arrived: a session cookie unwraps to a personId and calls this: so
 *  does a signed connection's bearer token (see makeAgentToken, and mcp.ts's
 *  reading of it). One query, one shape, wherever the subject came from. */
export async function principalFromPersonId(
  db: D1Database,
  personId: string
): Promise<Principal | null> {
  const person = await db
    .prepare('SELECT id, email, name, internal_role FROM person WHERE id = ?')
    .bind(personId)
    .first<{ id: string; email: string | null; name: string; internal_role: 'organizer' | 'reviewer' | null }>();
  if (!person) return null;
  const roles = await db
    .prepare('SELECT event_id, role FROM event_role WHERE person_id = ?')
    .bind(person.id)
    .all<{ event_id: string; role: string }>();
  const eventRoles: Record<string, string> = {};
  for (const r of roles.results) eventRoles[r.event_id] = r.role;
  return { personId: person.id, name: person.name, email: person.email, role: person.internal_role, eventRoles };
}

export async function principalFromCookie(
  db: D1Database,
  secret: string,
  cookieHeader: string | undefined
): Promise<Principal | null> {
  const m = /(?:^|;\s*)fs_s=([^;]+)/.exec(cookieHeader ?? '');
  if (!m) return null;
  const p = await verifyToken(secret, m[1]!);
  if (!p || p.purpose !== 'session') return null;
  return await principalFromPersonId(db, p.subjectId);
}

// ---------- signed connections (the agent tier) ----------

/** How long a minted connection acts as the person who minted it. Long enough
 *  that a working session is not re-minting a command every afternoon; short
 *  enough that a leaked one ages out. */
const AGENT_DAYS = 14;

/** A bearer credential for POST /mcp: 'Authorization: Bearer <this>' reads as
 *  this person for as long as it is valid. mcp.ts turns it back into a
 *  Principal with verifyToken + principalFromPersonId — the same two steps a
 *  session cookie goes through, purpose aside. */
export async function makeAgentToken(secret: string, personId: string): Promise<string> {
  return await signToken(secret, {
    purpose: 'agent',
    subjectId: personId,
    nonce: randomNonce(),
    exp: Date.now() + AGENT_DAYS * 86_400_000,
  });
}

// ---------- magic links ----------

export async function makeMagicLink(
  secret: string,
  origin: string,
  personId: string,
  /** Where to land after the link is followed — a same-origin path the
   *  caller has already vouched for. The magic route validates it again
   *  before honouring it, so a tampered address can only ever fall back to
   *  the standing-based landing, never redirect off-site. */
  next?: string | null
): Promise<string> {
  const token = await signToken(secret, {
    purpose: 'magic',
    subjectId: personId,
    nonce: randomNonce(),
    exp: Date.now() + 2 * 3_600_000,
  });
  const base = `${origin}/sign-in/magic?t=${encodeURIComponent(token)}`;
  return next ? `${base}&next=${encodeURIComponent(next)}` : base;
}

/** R-12 deliverability rule: real addresses get real email; the synthetic
 *  seed (@example.org / @example.com) never leaves the building. */
export function isRealAddress(email: string): boolean {
  return !/@example\.(org|com)$/i.test(norm(email));
}
