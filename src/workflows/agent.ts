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
import { addManualContact, inviteToSubmit } from './crm';
import { stageDecision, type Decision } from './decide';
import { completeTask, reopenTask, withdrawProposal } from './portal-actions';
import { taskActorId } from '../queries/helpers';
import { eventBySlug } from '../queries/public';

// The canonical public origin, for links the boundary writes into invite notes.
// A constant here (not a request-time value) because the boundary has no
// request — the same origin the rest of the worker publishes under.
const ORIGIN = 'https://onfireside.com';
// The most people one confirmed invite may reach. Above this it is a campaign,
// not an invite, and belongs in the outbox tooling, not a single agent act.
const INVITE_MAX = 100;

/* ------------------------------------------------------------------ *
 * Capabilities: what a principal may do, intersected with the surface
 * ------------------------------------------------------------------ */

export type Surface = 'event' | 'portal' | 'reviews' | 'backstage' | 'global';
export type Capability =
  | 'star'
  | 'connect'
  | 'follow'
  | 'review'
  | 'invite'
  | 'decide'
  | 'task' // a speaker (or their helper) marking their own deliverable task done / undone
  | 'withdraw'; // a speaker pulling their own proposal back
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
  // A decider (owner/approver, or install-wide organizer) is the only standing
  // that may invite or decide. An 'editor' can shape the event but not send —
  // Codex caught editor→decide as a privilege bug; a 'viewer' reads only.
  const isDecider = principal.role === 'organizer' || eventRole === 'owner' || eventRole === 'approver';
  // Inviting is stricter than deciding (Codex): it writes to the speaker CRM,
  // which requireOrg gates to an install-organizer or an event OWNER — an
  // approver decides proposals but does not manage the contact book. Keeping the
  // capability and the workflow's own guard in agreement means an approver is
  // refused cleanly at propose, never committed-then-thrown at execute.
  const isOwnerOrg = principal.role === 'organizer' || eventRole === 'owner';
  const isReviewer = principal.role === 'reviewer' || eventRole === 'reviewer';

  // The surface decides which of the principal's standings are in play here.
  const allow = (cap: Capability) => has.add(cap);
  switch (surface) {
    case 'event':
      // A visitor's own low-stakes acts on the public event pages. Never a
      // speaker/organizer/reviewer act, whatever the account also holds.
      allow('star');
      allow('connect');
      allow('follow');
      break;
    case 'portal':
      // The speaker portal: everything the event surface allows, PLUS a
      // speaker's self-service on their OWN tasks and proposals. Ownership is
      // enforced in each workflow's SQL (WHERE person_id / participation), so
      // like star the capability is portal-wide — the public event bubble
      // (surface 'event') never gets these, so speaker-facing content there can
      // never reach a withdraw.
      allow('star');
      allow('connect');
      allow('follow');
      allow('task');
      allow('withdraw');
      break;
    case 'reviews':
      if (isReviewer || isDecider) allow('review');
      break;
    case 'backstage':
      if (isDecider) allow('decide');
      if (isOwnerOrg) allow('invite');
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

/** An audit fingerprint of the exact executed args, NOT a tamper-evidence
 *  control (Codex): the row's args_json is immutable — nothing in this module
 *  updates it — so the args a human confirms are the args that run. The digest
 *  is what the audit records, so two commits of the same action are
 *  distinguishable, not a signature anyone verifies. If tamper resistance is
 *  ever needed, this becomes an HMAC bound to the row. */
async function digest(argsJson: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(argsJson));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ *
 * The action registry — each action owns its authorization + canonicalisation
 * ------------------------------------------------------------------ */

type Env = { DB: D1Database; FILES: R2Bucket };

type Canonical =
  // `subject` is the server's OWN name for what was acted on (the session's real
  // title, the person's real name), read from the database during validation.
  // The caller builds its confirmation from THIS, never from the model's
  // sentence (Codex): if an injected title steered the model to a different
  // valid target, the human still sees the true name of what actually happened.
  | { ok: true; args: Record<string, unknown>; manifest: string; subject: string; count?: number }
  | { ok: false; reason: string };

type ActionDef = {
  capability: Capability;
  tier: Tier;
  surfaces: Surface[];
  /** VALIDATE the concrete arguments the model resolved and FREEZE them. Never
   *  where a name becomes an id (that semantic resolution is the model's job,
   *  upstream) — only where a concrete id is checked against the world and a
   *  malformed or absent one is refused so the model can repair or clarify. */
  validateAndFreeze: (env: Env, p: Principal, eventId: string | null, raw: Record<string, unknown>) => Promise<Canonical>;
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
    async validateAndFreeze(env, _p, eventId, raw) {
      const submissionId = str(raw.submissionId);
      if (!submissionId || !eventId) return { ok: false, reason: 'no-session' };
      // Polarity is semantic and must be explicit — the server never guesses
      // star-vs-unstar from a missing or malformed value (Codex). A missing on
      // is a refusal, so the model asks or repairs.
      if (typeof raw.on !== 'boolean') return { ok: false, reason: 'no-polarity' };
      const on = raw.on;
      // The exact predicate setStar itself enforces, so canonicalisation and
      // execution never disagree: an accepted-or-cancelled, placed session on a
      // published agenda. Otherwise "done" would be a lie over a no-op write.
      const row = await env.DB
        .prepare(
          `SELECT s.title FROM submission s JOIN event e ON e.id = s.event_id
            WHERE s.id = ? AND s.event_id = ?
              AND s.state IN ('accepted','cancelled') AND s.starts_at IS NOT NULL
              AND e.agenda_published = 1`
        )
        .bind(submissionId, eventId)
        .first<{ title: string }>();
      if (!row) return { ok: false, reason: 'no-session' };
      return {
        ok: true,
        args: { submissionId, on },
        subject: row.title,
        manifest: `${on ? 'Star' : 'Unstar'} "${row.title}".`,
      };
    },
    async execute(env, p, eventId, args) {
      if (!eventId) return 'trouble';
      return setStar(env.DB, p.personId, eventId, str(args.submissionId), args.on === true);
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
    async validateAndFreeze(env, p, eventId, raw) {
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
      return { ok: true, args: { recipientId }, subject: row.name, manifest: `Send a connection request to ${row.name}?` };
    },
    async execute(env, p, eventId, args) {
      if (!eventId) return 'trouble';
      return sendFriendRequest(env.DB, eventId, p.personId, str(args.recipientId));
    },
  },

  // The organizer's flagship agentic act (D-037, the sniff-test headline): invite
  // a batch of people to submit to an open call. The external agent resolves the
  // recipients — reading the organizer's own Gmail, say — and passes concrete
  // name+email pairs; the server VALIDATES each, refuses a call that is not open,
  // freezes the exact list, and shows a manifest carrying the count. Bulk, so the
  // confirm is by-the-number: the human approves N specific people, and a
  // prompt-injected abstract can neither add a recipient nor change the count
  // that was approved. The write only ROSTERS each person and QUEUES a note to
  // the event's outbox — nothing is emailed until the organizer releases the
  // outbox — so the confirmed act's blast radius is a draft, not a send.
  invite: {
    capability: 'invite',
    tier: 'confirm-number',
    surfaces: ['backstage'],
    async validateAndFreeze(env, _p, eventId, raw) {
      if (!eventId) return { ok: false, reason: 'no-event' };
      const contacts = normalizeContacts(raw.contacts);
      if (!contacts.length) return { ok: false, reason: 'no-recipients' };
      if (contacts.length > INVITE_MAX) return { ok: false, reason: 'too-many' };
      const ev = await env.DB
        .prepare('SELECT slug, name FROM event WHERE id = ?')
        .bind(eventId)
        .first<{ slug: string; name: string }>();
      if (!ev) return { ok: false, reason: 'no-event' };
      // Only an OPEN call takes proposals; inviting to a closed one is a note
      // nobody can act on. Lifecycle is computed, so ask the query that owns it.
      const home = await eventBySlug(env.DB, ev.slug);
      if (!home || home.lifecycle !== 'open') return { ok: false, reason: 'not-open' };
      // Resolve every address to its CANONICAL identity NOW, so the human
      // confirms the real people (Codex P1/P2): an address already on file shows
      // the name we hold, never whatever the agent typed beside it; a new address
      // is shown as given and created on commit. The frozen list is these
      // resolved recipients, so execution invites exactly who was confirmed.
      const resolved: { name: string; email: string; personId: string | null }[] = [];
      for (const c of contacts) {
        const existing = await env.DB
          .prepare('SELECT id, name FROM person WHERE email = ? AND merged_into_id IS NULL')
          .bind(c.email)
          .first<{ id: string; name: string }>();
        resolved.push({ email: c.email, name: existing?.name ?? c.name, personId: existing?.id ?? null });
      }
      // The manifest lists EVERY recipient, name and address — nothing hidden
      // behind "and N more" (Codex P1). The human approves exactly these people.
      const lines = resolved.map((r) => `- ${r.name} <${r.email}>`).join('\n');
      return {
        ok: true,
        args: { contacts: resolved },
        subject: `${resolved.length} to ${ev.name}`,
        manifest: `Invite ${resolved.length} ${resolved.length === 1 ? 'person' : 'people'} to submit to ${ev.name}:\n${lines}`,
        count: resolved.length,
      };
    },
    async execute(env, p, eventId, args) {
      if (!eventId) return 'trouble';
      const recipients = Array.isArray(args.contacts)
        ? (args.contacts as { name: string; email: string; personId: string | null }[])
        : [];
      const ev = await env.DB
        .prepare('SELECT slug, name FROM event WHERE id = ?')
        .bind(eventId)
        .first<{ slug: string; name: string }>();
      if (!ev) return 'trouble';
      // Re-check the call is still open at execution: a proposal can outlive the
      // close by up to the pending TTL, and inviting to a shut call is a note
      // nobody can act on (Codex P3).
      const home = await eventBySlug(env.DB, ev.slug);
      if (!home || home.lifecycle !== 'open') return 'trouble';
      const cfpUrl = `${ORIGIN}/${ev.slug}/cfp`;
      let invited = 0;
      for (const r of recipients) {
        const personId = r.personId ?? (await findOrCreatePerson(env.DB, p, { name: r.name, email: r.email }));
        if (!personId) continue;
        const res = await inviteToSubmit(env.DB, p, { id: eventId, name: ev.name }, personId, cfpUrl);
        if (res.ok) invited++;
      }
      // 'done' when everyone the human confirmed was rostered and noted; a
      // partial run says so, so the caller never claims a full sweep it didn't do.
      return invited === recipients.length ? 'done' : invited > 0 ? 'partial' : 'trouble';
    },
  },

  // The organizer's core act, by chat/agent: accept / waitlist / decline one
  // proposal. Confirm-once (the design doc's tier for "stage a decision"): the
  // model resolves which proposal and which way, the server validates it is on
  // this event, names the proposal AND the speaker in the manifest, and the
  // human confirms before it lands. It is the "decided but not told" model — the
  // decision stages a letter into the outbox and changes nothing the speaker can
  // see; nothing reaches them until the organizer releases the outbox. So the
  // confirmed act is reversible and quiet, and stageDecision's own guard refuses
  // if someone else moved the proposal meanwhile.
  decide: {
    capability: 'decide',
    tier: 'confirm',
    surfaces: ['backstage'],
    async validateAndFreeze(env, _p, eventId, raw) {
      if (!eventId) return { ok: false, reason: 'no-event' };
      const submissionId = str(raw.submissionId);
      const decision = str(raw.decision);
      if (!submissionId) return { ok: false, reason: 'no-proposal' };
      // The three real dispositions, stated by the model, validated here — never
      // a fourth the server invents.
      if (decision !== 'accepted' && decision !== 'waitlisted' && decision !== 'rejected') {
        return { ok: false, reason: 'bad-decision' };
      }
      const row = await env.DB
        .prepare(
          `SELECT s.title, pe.name AS speaker FROM submission s
             JOIN participation pa ON pa.submission_id = s.id AND pa.is_submitter = 1
             JOIN person pe ON pe.id = pa.person_id
            WHERE s.id = ? AND s.event_id = ?`
        )
        .bind(submissionId, eventId)
        .first<{ title: string; speaker: string }>();
      if (!row) return { ok: false, reason: 'no-proposal' };
      const verb = decision === 'accepted' ? 'Accept' : decision === 'waitlisted' ? 'Waitlist' : 'Decline';
      return {
        ok: true,
        args: { submissionId, decision },
        subject: row.title,
        manifest: `${verb} "${row.title}" by ${row.speaker}. Staged only — nothing reaches ${row.speaker} until you release the outbox.`,
      };
    },
    async execute(env, p, eventId, args) {
      if (!eventId) return 'trouble';
      const r = await stageDecision(env.DB, p, eventId, str(args.submissionId), args.decision as Decision, null);
      // stageDecision never throws (it returns {ok:false} on a stale/illegal
      // move); a failure means the world moved, so say so honestly.
      return r.ok ? 'done' : 'moved';
    },
  },

  // A speaker (or their helper) marks one of their own deliverable tasks done.
  // Direct + reversible: self-scoped, undoable by task_reopen. The ACTOR is
  // resolved by taskActorId — the task's owner when the principal owns it OR is
  // an active helper of the owner — so an assistant's agent completes the deck
  // reminder AS the speaker, and a stranger resolves to null and is refused.
  task_done: {
    capability: 'task',
    tier: 'direct',
    surfaces: ['portal'],
    async validateAndFreeze(env, p, eventId, raw) {
      const taskId = str(raw.taskId);
      if (!taskId || !eventId) return { ok: false, reason: 'no-task' };
      const actorId = await taskActorId(env.DB, taskId, p.personId);
      if (!actorId) return { ok: false, reason: 'no-task' };
      const row = await env.DB
        .prepare(
          `SELECT t.title FROM task t JOIN submission s ON s.id = t.submission_id
            WHERE t.id = ? AND t.person_id = ? AND s.event_id = ?
              AND t.completed_at IS NULL AND t.cancelled_at IS NULL`
        )
        .bind(taskId, actorId, eventId)
        .first<{ title: string }>();
      if (!row) return { ok: false, reason: 'no-task' };
      return { ok: true, args: { taskId, actorId }, subject: row.title, manifest: `Mark "${row.title}" done.` };
    },
    async execute(env, _p, _eventId, args) {
      return completeTask(env.DB, str(args.actorId), str(args.taskId));
    },
  },

  // The undo of task_done — put a completed task back on the list. Same actor
  // resolution, so a helper can undo their own mistake for the speaker.
  task_reopen: {
    capability: 'task',
    tier: 'direct',
    surfaces: ['portal'],
    async validateAndFreeze(env, p, eventId, raw) {
      const taskId = str(raw.taskId);
      if (!taskId || !eventId) return { ok: false, reason: 'no-task' };
      const actorId = await taskActorId(env.DB, taskId, p.personId);
      if (!actorId) return { ok: false, reason: 'no-task' };
      const row = await env.DB
        .prepare(
          `SELECT t.title FROM task t JOIN submission s ON s.id = t.submission_id
            WHERE t.id = ? AND t.person_id = ? AND s.event_id = ?
              AND t.completed_at IS NOT NULL AND t.cancelled_at IS NULL`
        )
        .bind(taskId, actorId, eventId)
        .first<{ title: string }>();
      if (!row) return { ok: false, reason: 'no-task' };
      return { ok: true, args: { taskId, actorId }, subject: row.title, manifest: `Put "${row.title}" back on your list.` };
    },
    async execute(env, _p, _eventId, args) {
      return reopenTask(env.DB, str(args.actorId), str(args.taskId));
    },
  },

  // A speaker pulls their OWN proposal back. Confirm-tier: withdrawn is terminal
  // (the transition trigger allows no move out of it — there is no un-withdraw),
  // and it removes the talk from the committee's list. NO helper substitution
  // here — withdraw is the speaker's own act, so it binds principal.personId
  // directly; a helper's participation row does not match, so a helper is
  // cleanly refused, which is exactly "a helper can't withdraw".
  withdraw_proposal: {
    capability: 'withdraw',
    tier: 'confirm',
    surfaces: ['portal'],
    async validateAndFreeze(env, p, eventId, raw) {
      const submissionId = str(raw.submissionId);
      if (!submissionId || !eventId) return { ok: false, reason: 'no-proposal' };
      const row = await env.DB
        .prepare(
          `SELECT s.title FROM submission s
             JOIN participation pa ON pa.submission_id = s.id AND pa.person_id = ?
            WHERE s.id = ? AND s.event_id = ?
              AND s.state IN ('submitted','waitlisted','accepted')
              AND NOT (s.agenda_published = 1 AND s.starts_at IS NOT NULL)`
        )
        .bind(p.personId, submissionId, eventId)
        .first<{ title: string }>();
      if (!row) return { ok: false, reason: 'no-proposal' };
      return {
        ok: true,
        args: { submissionId },
        subject: row.title,
        manifest: `Withdraw "${row.title}"? It leaves the committee's list, and you cannot put it back.`,
      };
    },
    async execute(env, p, _eventId, args) {
      return withdrawProposal(env.DB, p.personId, str(args.submissionId));
    },
  },
};

/** The recipients an agent passed, made safe to freeze: a trimmed name and a
 *  lowercased address with an @, de-duplicated by address. Pure — the model
 *  resolved WHO (from Gmail, wherever); this only checks the shape and refuses
 *  the malformed, so a garbage entry never reaches a person row. */
export function normalizeContacts(raw: unknown): { name: string; email: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { name: string; email: string }[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const email = typeof rec.email === 'string' ? rec.email.trim().toLowerCase() : '';
    if (!name || !email.includes('@')) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ name, email });
  }
  return out;
}

/** Turn one resolved contact into a person id, creating the prospect if new and
 *  finding the existing row when the address is already known. Null only when
 *  neither works, so the invite skips exactly that one and rosters the rest. */
async function findOrCreatePerson(
  db: D1Database,
  p: Principal,
  c: { name: string; email: string }
): Promise<string | null> {
  const created = await addManualContact(db, p, { name: c.name, email: c.email });
  if (created.ok) return created.personId;
  if (created.code === 'taken') {
    const existing = await db.prepare('SELECT id FROM person WHERE email = ?').bind(c.email).first<{ id: string }>();
    return existing?.id ?? null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Propose and commit — the DB shells around the pure decisions above
 * ------------------------------------------------------------------ */

const PENDING_TTL_MS = 15 * 60 * 1000; // a proposal a human ignores for 15 minutes is stale
const MAX_OPEN_PENDING = 25; // a flood guard: one person's open proposals are bounded

export type ProposeResult =
  // Direct-tier ran inline. 'executed' means the PATH ran — `outcome` is the
  // workflow's own word ('done'/'moved'/'trouble' for social acts), which says
  // whether it actually succeeded. The caller must read the outcome, not assume.
  // `subject` is the server's true name for the target, for an honest sentence.
  | { kind: 'executed'; outcome: string; subject: string }
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
  // rejects, never merely omits from a list). Note (Codex P3): this checks the
  // request-time `principal`, not a fresh DB read. For a direct, self-scoped
  // act like star — which every authenticated principal holds — that is safe.
  // The confirm-tier COMMIT is where live re-authorization against a re-loaded
  // principal will matter, once role-revocable actions (invite/decide) ship;
  // commitPendingAction is the seam for that reload, and it is a v1-scoped gap,
  // not a v1-star exposure.
  if (!def.surfaces.includes(where.surface)) return { kind: 'refused', reason: 'not-here' };
  if (!capabilitiesOf(principal, where.eventId, where.surface).has(def.capability)) {
    return { kind: 'refused', reason: 'not-allowed' };
  }

  const c = await def.validateAndFreeze(env, principal, where.eventId, raw);
  if (!c.ok) return { kind: 'refused', reason: c.reason };

  // A prompt-injected agent must not be able to flood the ledger with pending
  // manifests (each holds a name/id). One person may hold only so many open
  // proposals at once; over that, propose refuses until they resolve some.
  if (def.tier !== 'direct') {
    const open = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM pending_action WHERE person_id = ? AND status = 'open'`)
      .bind(principal.personId)
      .first<{ n: number }>();
    if ((open?.n ?? 0) >= MAX_OPEN_PENDING) return { kind: 'refused', reason: 'too-many-pending' };
  }

  if (def.tier === 'direct') {
    const outcome = await def.execute(env, principal, where.eventId, c.args);
    await audit(env, principal.personId, where.eventId, actionType, await digest(JSON.stringify(c.args)), outcome, nowMs);
    return { kind: 'executed', outcome, subject: c.subject };
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

export type CommitResult =
  | { ok: true; outcome: string; actionType: string }
  | { ok: false; reason: CommitRefusal | 'unknown-action' | 'not-committable' };

export async function commitPendingAction(
  env: Env,
  principal: Principal,
  pendingId: string,
  providedNumber: number | null = null,
  nowMs: number = now(),
  // When set, only these action types may be committed through this caller — the
  // MCP commit tool passes ['invite'] so it can never be tricked into committing
  // some OTHER owned pending (a connect, a future higher-stakes act) it did not
  // propose (Codex P3). In-product callers pass nothing and commit any owned act.
  allowedActions?: string[]
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
  if (allowedActions && !allowedActions.includes(row.action_type)) return { ok: false, reason: 'not-committable' };

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
  // only the update that finds status='open' changes a row. This is AT-MOST-ONCE
  // by design (Codex): the status flips before execute, so a Worker death
  // between the two leaves the action un-run and every retry reads 'gone'. That
  // is the SAFE failure direction for a boundary that can send 610 letters —
  // under-execute, never double-execute — and the human simply sees no result
  // and re-proposes. Exactly-once (execute+status+audit in one transaction, or
  // a durable outbox with executing/succeeded/failed states) is the documented
  // next step, not v1.
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
  return { ok: true, outcome, actionType: row.action_type };
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
