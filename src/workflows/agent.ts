// The agentic-write protocol (D-037). The concierge's planner is untrusted: it
// only ever PROPOSES an action. This module is the trusted boundary between a
// proposal and a real state change.
//
// Two phases, and the security lives in both being separate:
//   1. propose — the server checks the principal has the capability on this
//      surface, canonicalises the arguments (resolves names to ids, refuses
//      ambiguity), and for anything that needs confirming, freezes the exact
//      arguments in a pending_action row (schema 0015) with a digest and an
//      expiry. A direct-tier act (reversible, self-scoped) runs inline instead.
//   2. commit — a human confirms the exact stored manifest through a surface
//      the model never authored; the server re-authorises against LIVE
//      capability, validates the state machine (owned, open, unexpired, and for
//      a numbered tier the number re-stated), flips the row to committed once
//      (guarded, so a double-commit loses), and executes with the STORED
//      arguments — never anything the model said at commit time.
//
// So a prompt-injected or hallucinating planner can at most create a row a
// human rejects. It can never reach a workflow with arguments nobody saw, act
// above the asker's standing, replay a committed action, or send a different
// count than the human confirmed.
//
// THE DIVISION OF LABOUR (operator's law, 2026-08-16). This module is
// deliberately, entirely deterministic, because it is the security boundary and
// a security boundary an LLM can talk its way past is no boundary. But that is
// the ONLY place determinism belongs. Understanding what the human meant,
// which action they want, and WHO "the person I met at the vibecoding talk" is
// — all of that is SEMANTIC and belongs to the LLM, working with the read tools
// and asking the human when unsure. A canonicalize() here never name-matches or
// guesses; it VALIDATES a concrete id the model already resolved and shows an
// honest manifest. Suppleness upstream, determinism at the boundary. Efficiency
// comes from CACHING the model's semantic decisions, never from regexes or
// brittle rules.

import { checkedBatch, newId, now } from '../lib/db';
import type { Principal } from './account';
import { setStar } from './social';
import { sendFriendRequest } from './friends';

/* ------------------------------------------------------------------ *
 * Capabilities: what a principal may do, intersected with the surface
 * ------------------------------------------------------------------ */

export type Surface = 'event' | 'portal' | 'reviews' | 'backstage' | 'global';
export type Capability = 'star' | 'connect' | 'follow' | 'review' | 'invite' | 'decide';
export type Tier = 'direct' | 'confirm' | 'confirm-number';

/** Everything this principal is allowed to do, on this event, from this
 *  surface. The intersection is deliberate (Codex): a person who is both an
 *  organizer and a speaker, using the concierge in the speaker portal, gets
 *  only what the portal exposes — so speaker-facing content can never reach an
 *  organizer action just because the account holds standing elsewhere. Pure,
 *  and re-computed live at commit; never cached from propose time. */
export function capabilitiesOf(principal: Principal, eventId: string | null, surface: Surface): Set<Capability> {
  const has = new Set<Capability>();
  const eventRole = eventId ? principal.eventRoles[eventId] : undefined;
  const isOrganizer = principal.role === 'organizer' || eventRole === 'owner' || eventRole === 'approver' || eventRole === 'editor';
  const isReviewer = principal.role === 'reviewer' || eventRole === 'reviewer';

  // The surface decides which of the principal's standings are in play here.
  const allow = (cap: Capability) => has.add(cap);
  switch (surface) {
    case 'event':
    case 'portal':
      // An attendee's own low-stakes acts, and a speaker's self-service (the
      // portal). Never an organizer or reviewer act, whatever the account also
      // holds elsewhere.
      allow('star');
      allow('connect');
      allow('follow');
      break;
    case 'reviews':
      if (isReviewer || isOrganizer) allow('review');
      break;
    case 'backstage':
      if (isOrganizer) {
        allow('invite');
        allow('decide');
      }
      break;
    case 'global':
      // Nothing state-changing before a conference is even chosen. Onboarding
      // acts (create a conference) are deliberately not here in v1.
      break;
  }
  return has;
}

/* ------------------------------------------------------------------ *
 * The commit state machine — pure, so every refusal is a unit test
 * ------------------------------------------------------------------ */

export type Pending = {
  id: string;
  personId: string;
  eventId: string | null;
  surface: Surface;
  actionType: string;
  tier: 'confirm' | 'confirm-number';
  countExpected: number | null;
  expiresAt: number;
  status: string;
};

export type CommitRefusal = 'not-yours' | 'gone' | 'expired' | 'not-allowed' | 'wrong-number';
export type CommitDecision = { ok: true } | { ok: false; reason: CommitRefusal };

/** The whole security decision for a commit, as a pure function of the stored
 *  row, who is asking, whether they still hold the capability, the clock, and
 *  the number they re-stated. Order matters: ownership, then liveness, then
 *  live authorization, then the number. */
export function commitDecision(
  p: Pending,
  principalPersonId: string,
  hasCapabilityNow: boolean,
  nowMs: number,
  providedNumber: number | null
): CommitDecision {
  if (p.personId !== principalPersonId) return { ok: false, reason: 'not-yours' };
  if (p.status !== 'open') return { ok: false, reason: 'gone' }; // committed or cancelled — no replay
  if (p.expiresAt <= nowMs) return { ok: false, reason: 'expired' };
  if (!hasCapabilityNow) return { ok: false, reason: 'not-allowed' }; // re-authorised live, not from propose time
  if (p.tier === 'confirm-number') {
    if (providedNumber === null || providedNumber !== p.countExpected) return { ok: false, reason: 'wrong-number' };
  }
  return { ok: true };
}

async function digest(argsJson: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(argsJson));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ *
 * The action registry — each action owns its authorization + canonicalisation
 * ------------------------------------------------------------------ */

type Env = { DB: D1Database; FILES: R2Bucket };

type Canonical =
  | { ok: true; args: Record<string, unknown>; manifest: string; count?: number }
  | { ok: false; reason: string };

type ActionDef = {
  capability: Capability;
  tier: Tier;
  surfaces: Surface[];
  /** Resolve and freeze the arguments. This is where a name becomes an id and
   *  an ambiguous or absent target is refused (never guessed). */
  canonicalize: (env: Env, p: Principal, eventId: string | null, raw: Record<string, unknown>) => Promise<Canonical>;
  /** Execute the stored, canonical args through the real guarded workflow. */
  execute: (env: Env, p: Principal, eventId: string | null, args: Record<string, unknown>) => Promise<string>;
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export const ACTIONS: Record<string, ActionDef> = {
  // Reversible, self-scoped: run inline, no confirm.
  star: {
    capability: 'star',
    tier: 'direct',
    surfaces: ['event', 'portal'],
    async canonicalize(env, _p, eventId, raw) {
      const submissionId = str(raw.submissionId);
      if (!submissionId || !eventId) return { ok: false, reason: 'no-session' };
      const row = await env.DB
        .prepare(`SELECT title FROM submission WHERE id = ? AND event_id = ? AND state = 'accepted'`)
        .bind(submissionId, eventId)
        .first<{ title: string }>();
      if (!row) return { ok: false, reason: 'no-session' };
      const on = raw.on !== false;
      return { ok: true, args: { submissionId, on }, manifest: `${on ? 'Star' : 'Unstar'} "${row.title}".` };
    },
    async execute(env, p, eventId, args) {
      if (!eventId) return 'trouble';
      return setStar(env.DB, p.personId, eventId, str(args.submissionId), args.on !== false);
    },
  },

  // Touches another person: confirm once. The LLM does the SEMANTIC work of
  // deciding who "the person I met at the vibecoding talk" is — using the read
  // tools and, when unsure, asking the human in conversation — and passes a
  // concrete recipientId. The server does not name-match or guess; it only
  // VALIDATES that id is a real, connectable attendee here and shows the
  // person's true name in the manifest, so the human confirming catches a
  // wrong target. Suppleness upstream (the model), determinism at the
  // boundary (here).
  connect_request: {
    capability: 'connect',
    tier: 'confirm',
    surfaces: ['event', 'portal'],
    async canonicalize(env, p, eventId, raw) {
      const recipientId = str(raw.recipientId);
      if (!recipientId || !eventId) return { ok: false, reason: 'no-person' };
      if (recipientId === p.personId) return { ok: false, reason: 'self' };
      // The target must be someone actually using this event's schedule — the
      // same pool the connect UI draws from (a my_schedule row here), never an
      // arbitrary person id the planner produced.
      const row = await env.DB
        .prepare(
          `SELECT pe.name FROM person pe
             JOIN my_schedule ms ON ms.person_id = pe.id AND ms.event_id = ?
            WHERE pe.id = ?`
        )
        .bind(eventId, recipientId)
        .first<{ name: string }>();
      if (!row) return { ok: false, reason: 'nobody' };
      return { ok: true, args: { recipientId }, manifest: `Send a connection request to ${row.name}?` };
    },
    async execute(env, p, eventId, args) {
      if (!eventId) return 'trouble';
      return sendFriendRequest(env.DB, eventId, p.personId, str(args.recipientId));
    },
  },
};

/* ------------------------------------------------------------------ *
 * Propose and commit — the DB shells around the pure decisions above
 * ------------------------------------------------------------------ */

const PENDING_TTL_MS = 15 * 60 * 1000; // a proposal a human ignores for 15 minutes is stale

export type ProposeResult =
  | { kind: 'done'; outcome: string } // direct-tier, executed inline
  | { kind: 'pending'; id: string; manifest: string; tier: 'confirm' | 'confirm-number'; count: number | null }
  | { kind: 'refused'; reason: string };

export async function proposeAction(
  env: Env,
  principal: Principal,
  where: { eventId: string | null; surface: Surface },
  actionType: string,
  raw: Record<string, unknown>,
  nowMs: number = now()
): Promise<ProposeResult> {
  const def = ACTIONS[actionType];
  if (!def) return { kind: 'refused', reason: 'unknown-action' };
  // Authorization first, and it must hold for this surface (the dispatcher
  // rejects, never merely omits from a list).
  if (!def.surfaces.includes(where.surface)) return { kind: 'refused', reason: 'not-here' };
  if (!capabilitiesOf(principal, where.eventId, where.surface).has(def.capability)) {
    return { kind: 'refused', reason: 'not-allowed' };
  }

  const c = await def.canonicalize(env, principal, where.eventId, raw);
  if (!c.ok) return { kind: 'refused', reason: c.reason };

  if (def.tier === 'direct') {
    const outcome = await def.execute(env, principal, where.eventId, c.args);
    await audit(env, principal.personId, where.eventId, actionType, await digest(JSON.stringify(c.args)), outcome, nowMs);
    return { kind: 'done', outcome };
  }

  const argsJson = JSON.stringify(c.args);
  const id = newId('pa');
  await env.DB
    .prepare(
      `INSERT INTO pending_action
        (id, person_id, event_id, surface, action_type, args_json, args_digest, manifest, tier, count_expected, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      id,
      principal.personId,
      where.eventId,
      where.surface,
      actionType,
      argsJson,
      await digest(argsJson),
      c.manifest,
      def.tier,
      c.count ?? null,
      nowMs,
      nowMs + PENDING_TTL_MS
    )
    .run();
  return { kind: 'pending', id, manifest: c.manifest, tier: def.tier, count: c.count ?? null };
}

export type CommitResult = { ok: true; outcome: string } | { ok: false; reason: CommitRefusal | 'unknown-action' };

export async function commitPendingAction(
  env: Env,
  principal: Principal,
  pendingId: string,
  providedNumber: number | null = null,
  nowMs: number = now()
): Promise<CommitResult> {
  const row = await env.DB
    .prepare(
      `SELECT id, person_id, event_id, surface, action_type, args_json, tier, count_expected, expires_at, status
         FROM pending_action WHERE id = ?`
    )
    .bind(pendingId)
    .first<{
      id: string;
      person_id: string;
      event_id: string | null;
      surface: string;
      action_type: string;
      args_json: string;
      tier: 'confirm' | 'confirm-number';
      count_expected: number | null;
      expires_at: number;
      status: string;
    }>();
  if (!row) return { ok: false, reason: 'gone' };

  const def = ACTIONS[row.action_type];
  if (!def) return { ok: false, reason: 'unknown-action' };

  const pending: Pending = {
    id: row.id,
    personId: row.person_id,
    eventId: row.event_id,
    surface: row.surface as Surface,
    actionType: row.action_type,
    tier: row.tier,
    countExpected: row.count_expected,
    expiresAt: row.expires_at,
    status: row.status,
  };
  // Live re-authorization: the capability is recomputed now, not trusted from
  // when the row was written.
  const hasCap = capabilitiesOf(principal, row.event_id, row.surface as Surface).has(def.capability);
  const decision = commitDecision(pending, principal.personId, hasCap, nowMs, providedNumber);
  if (!decision.ok) return { ok: false, reason: decision.reason };

  // Flip to committed once. The guard makes a concurrent double-commit lose:
  // only the update that finds status='open' changes a row.
  try {
    await checkedBatch(
      env.DB,
      [
        env.DB
          .prepare(`UPDATE pending_action SET status = 'committed', committed_at = ? WHERE id = ? AND status = 'open'`)
          .bind(nowMs, pendingId),
      ],
      [{ atLeast: 1 }],
      'stale'
    );
  } catch {
    return { ok: false, reason: 'gone' }; // someone (or a retry) committed it first
  }

  const args = JSON.parse(row.args_json) as Record<string, unknown>;
  const outcome = await def.execute(env, principal, row.event_id, args);
  await audit(env, principal.personId, row.event_id, row.action_type, await digest(row.args_json), outcome, nowMs);
  return { ok: true, outcome };
}

export async function cancelPendingAction(env: Env, principal: Principal, pendingId: string): Promise<void> {
  await env.DB
    .prepare(`UPDATE pending_action SET status = 'cancelled' WHERE id = ? AND person_id = ? AND status = 'open'`)
    .bind(pendingId, principal.personId)
    .run();
}

async function audit(
  env: Env,
  personId: string,
  eventId: string | null,
  actionType: string,
  argsDigest: string,
  outcome: string,
  nowMs: number
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO agent_audit (id, person_id, event_id, action_type, args_digest, outcome, at) VALUES (?,?,?,?,?,?,?)`
    )
    .bind(newId('aud'), personId, eventId, actionType, argsDigest, outcome, nowMs)
    .run();
}
