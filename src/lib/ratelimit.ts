// The daily budget behind Ask — the one place that decides whether a question
// is allowed to cost a model call, and the only writer of `ai_budget`.
//
// Why a table rather than a counter in memory: a Worker keeps nothing between
// requests, so the honest answer to "how many have I taken today" has to
// outlive the isolate that took them. `ai_budget` is exactly that table — its
// DDL is (day, ip) with '_global' holding the day's total for everyone.
//
// Why the identifier is hashed: the promise Ask makes is that asking costs you
// nothing and tells nobody who you are — the `question` table carries no
// person_id, by design, and that promise would be quietly broken if the
// counter beside it held a raw address. The digest is salted with the day, so
// yesterday's rows cannot be lined up against today's, and a row that ages out
// takes its subject with it.
//
// The cap is deliberately tight for anonymous askers and looser once you have
// signed in. Turnstile has not arrived yet (see the parcel report); until it
// does, the cap is the whole defence, so it errs small.

import { checkedBatch, guard, StaleStateError } from './db';

/** Everyone's share of one day, before anybody signs in. */
export const ANON_DAILY = 6;
/** Signed in, so there is a name behind the asking. */
export const SIGNED_IN_DAILY = 25;
/** The whole install's day. Reached first only if something is going wrong. */
export const EVERYONE_DAILY = 400;

/** The DDL's own word for the row that counts the day rather than a person. */
const GLOBAL = '_global';

export type Claim =
  /** Taken. `left` is what remains to this asker today. */
  | { ok: true; left: number }
  /** Not taken, and no model call was made. `who` picks the sentence. */
  | { ok: false; who: 'you' | 'everyone' };

/**
 * The day a spend belongs to, as the ledger keys it. UTC on purpose: this is
 * a spend counter, not a date anybody reads, and a single key beats a per-event
 * timezone that would let one asker roll over three times in a day.
 */
export function budgetDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** The address behind the request, as Cloudflare hands it over. */
export function clientIp(header: string | null | undefined): string {
  const ip = (header ?? '').trim();
  // Local runs and stray requests share one bucket rather than getting a free
  // one each — an unknown address is the cheapest thing in the world to forge.
  return ip || 'unknown';
}

async function digest(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let out = '';
  for (let i = 0; i < 12; i++) out += hash[i]!.toString(16).padStart(2, '0');
  return out;
}

/**
 * The ledger key for one asker on one day. Signed-in people are counted by
 * who they are, so a whole conference on one venue address does not share a
 * single allowance; everyone else is counted by address, which is all there is.
 */
export async function askerKey(
  day: string,
  ip: string,
  personId: string | null
): Promise<string> {
  return personId
    ? `p-${await digest(`${day}:person:${personId}`)}`
    : `a-${await digest(`${day}:from:${ip}`)}`;
}

type Counters = { mine: number; everyone: number };

async function read(db: D1Database, day: string, key: string): Promise<Counters> {
  const res = await db
    .prepare('SELECT ip, spent FROM ai_budget WHERE day = ? AND ip IN (?, ?)')
    .bind(day, key, GLOBAL)
    .all<{ ip: string; spent: number }>();
  const find = (k: string) => res.results.find((r) => r.ip === k)?.spent ?? 0;
  return { mine: find(key), everyone: find(GLOBAL) };
}

/**
 * Take one from today's budget, or refuse without spending anything.
 *
 * The read decides which sentence the screen gets to say; the two guards in the
 * batch are what actually holds, so two questions arriving at once cannot both
 * squeeze past the last unit. A guard firing surfaces as StaleStateError, and
 * we re-read rather than guess which of the two fired.
 *
 * `spend: false` asks the same question without taking anything — the screen
 * uses it for the answers that are free to give but should still stop counting
 * once somebody has had their day's worth.
 */
export async function claimAsk(
  db: D1Database,
  opts: { ip: string; personId: string | null; nowMs: number; spend?: boolean }
): Promise<Claim> {
  const day = budgetDay(opts.nowMs);
  const cap = opts.personId ? SIGNED_IN_DAILY : ANON_DAILY;
  const key = await askerKey(day, opts.ip, opts.personId);

  const before = await read(db, day, key);
  if (before.everyone >= EVERYONE_DAILY) return { ok: false, who: 'everyone' };
  if (before.mine >= cap) return { ok: false, who: 'you' };
  if (opts.spend === false) return { ok: true, left: cap - before.mine };

  const bump = (ledgerKey: string) =>
    db
      .prepare(
        'INSERT INTO ai_budget (day, ip, spent) VALUES (?, ?, 1) ' +
          'ON CONFLICT(day, ip) DO UPDATE SET spent = spent + 1'
      )
      .bind(day, ledgerKey);

  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 FROM ai_budget WHERE day = ? AND ip = ? AND spent >= ?', day, key, cap),
        guard(
          db,
          'SELECT 1 FROM ai_budget WHERE day = ? AND ip = ? AND spent >= ?',
          day,
          GLOBAL,
          EVERYONE_DAILY
        ),
        bump(key),
        bump(GLOBAL),
      ],
      [0, 0, 1, 1],
      'the day filled up while you were typing'
    );
  } catch (e) {
    if (e instanceof StaleStateError) {
      const after = await read(db, day, key);
      return { ok: false, who: after.everyone >= EVERYONE_DAILY ? 'everyone' : 'you' };
    }
    throw e;
  }

  return { ok: true, left: Math.max(0, cap - before.mine - 1) };
}
