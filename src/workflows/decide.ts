// Deciding is the first act. Staging a decision writes the state, bumps the
// decision clock, and stages the letter — nothing leaves. Telling is release.ts.
import { checkedBatch, guard, newId, now } from '../lib/db';
import type { Principal } from './account';
import { ScopeError } from '../queries/admin';

const CAN_DECIDE = new Set(['owner', 'approver']);

export function requireDecider(principal: Principal, eventId: string): void {
  if (principal.role === 'organizer') return;
  const r = principal.eventRoles[eventId];
  if (!r || !CAN_DECIDE.has(r)) throw new ScopeError('deciding needs approval power on this event');
}

export type Decision = 'accepted' | 'waitlisted' | 'rejected';

const LETTER: Record<Decision, { subject: string; body: (eventName: string, decideNote: string | null) => string }> = {
  accepted: {
    subject: 'Your talk is on the program',
    body: (ev, note) =>
      `You are on the program at ${ev}. We will write again with your time and room.` +
      (note ? `\n\nFrom the committee:\n${note}` : ''),
  },
  waitlisted: {
    subject: 'Your talk is waitlisted — a place may still open',
    body: (ev, note) =>
      `The committee wants this one at ${ev} if space allows. We will know by the week of the event.` +
      (note ? `\n\nFrom the committee:\n${note}` : ''),
  },
  rejected: {
    subject: 'Not this time',
    body: (ev, note) =>
      `The committee did not choose this one for ${ev}. Please send it again next year.` +
      (note ? `\n\nFrom the committee:\n${note}` : ''),
  },
};

/**
 * Stage one decision. Legal-transition enforcement lives in the DB trigger;
 * its refusal surfaces as the screen's own sentence. The reversal cascade:
 * un-accepting clears placement and cancels open tasks (decision_reversal);
 * re-accepting reopens only what the reversal cancelled.
 */
export async function stageDecision(
  db: D1Database,
  principal: Principal,
  eventId: string,
  submissionId: string,
  decision: Decision,
  note: string | null,
  // When set (the agentic confirm path), the decision_version the human saw when
  // they staged this. If the proposal has moved since — another organizer
  // accepted and placed it — the commit is refused rather than becoming a
  // silent reversal the confirmed manifest never mentioned (Codex).
  expectVersion?: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  requireDecider(principal, eventId);

  const sub = await db
    .prepare(
      'SELECT s.id, s.state, s.decision_version, s.event_id, e.name AS event_name, p.person_id FROM submission s JOIN event e ON e.id = s.event_id JOIN participation p ON p.submission_id = s.id AND p.is_submitter = 1 WHERE s.id = ? AND s.event_id = ?'
    )
    .bind(submissionId, eventId)
    .first<{ id: string; state: string; decision_version: number; event_name: string; person_id: string }>();
  if (!sub) return { ok: false, error: 'That proposal is not on this event.' };
  if (expectVersion !== undefined && sub.decision_version !== expectVersion) {
    return { ok: false, error: 'That proposal moved since you staged this decision. Look again and decide fresh.' };
  }
  if (sub.state === decision) return { ok: true }; // idempotent — same call twice is one decision

  const t = now();
  const newVersion = sub.decision_version + 1;
  const unAccepting = sub.state === 'accepted' && decision !== 'accepted';
  const reAccepting = decision === 'accepted' && (sub.state === 'waitlisted' || sub.state === 'rejected');
  const letter = LETTER[decision];

  const statements = [
    // if someone else decided meanwhile, the whole batch refuses
    guard(
      db,
      'SELECT 1 FROM submission WHERE id = ?1 AND (state <> ?2 OR decision_version <> ?3)',
      submissionId,
      sub.state,
      sub.decision_version
    ),
    db
      .prepare(
        `UPDATE submission SET state = ?2, decision_version = ?3, decided_at = ?4, decision_note = ?5, notified_at = NULL${
          unAccepting ? ', starts_at = NULL, room_id = NULL, public_slug = NULL' : ''
        } WHERE id = ?1`
      )
      .bind(submissionId, decision, newVersion, t, note),
    // stale staged letters for this proposal die with the old version
    db
      .prepare("DELETE FROM message WHERE submission_id = ?1 AND kind = 'decision' AND delivered_at IS NULL")
      .bind(submissionId),
    db
      .prepare(
        'INSERT INTO message (id, event_id, person_id, submission_id, kind, decision_version, subject, body, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .bind(
        newId('msg'),
        eventId,
        sub.person_id,
        submissionId,
        'decision',
        newVersion,
        letter.subject,
        letter.body(sub.event_name, note),
        t
      ),
  ];
  const expect: (number | 'any')[] = [0, 1, 'any', 1];

  if (unAccepting) {
    statements.push(
      db
        .prepare(
          "UPDATE task SET cancelled_at = ?2, cancel_reason = 'decision_reversal' WHERE submission_id = ?1 AND completed_at IS NULL AND cancelled_at IS NULL"
        )
        .bind(submissionId, t)
    );
    expect.push('any');
  }
  if (reAccepting) {
    statements.push(
      db
        .prepare(
          "UPDATE task SET cancelled_at = NULL, cancel_reason = NULL WHERE submission_id = ?1 AND cancel_reason = 'decision_reversal'"
        )
        .bind(submissionId)
    );
    expect.push('any');
  }

  try {
    await checkedBatch(db, statements, expect, 'Someone else decided this one while you were reading it.');
  } catch (e) {
    if (String(e).includes('illegal transition')) {
      return { ok: false, error: 'That move is not open from where this proposal stands.' };
    }
    if (e instanceof Error && e.name === 'StaleStateError') return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true };
}
