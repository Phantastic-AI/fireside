// Deciding is the first act. Staging a decision writes the state, bumps the
// decision clock, and stages the letter — nothing leaves. Telling is release.ts.
import { eventDates } from '../lib/letters';

// The canonical public origin, for the portal link every letter carries.
const ORIGIN = 'https://onfireside.com';
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

/** What a decision letter knows about the talk it is about. Every field here
 *  exists because a reader alone in an inbox needs it: the title so a speaker
 *  with two proposals out knows WHICH one this is (the failure an adversarial
 *  read caught as the worst in the product), the dates so an acceptance can be
 *  forwarded for travel approval, the portal so there is a way back in. */
export type LetterFacts = {
  title: string;
  eventName: string;
  dates: string;
  portalUrl: string;
  note: string | null;
};

const from = (f: LetterFacts): string =>
  f.dates ? `${f.eventName}, ${f.dates}` : f.eventName;
const said = (note: string | null): string =>
  note ? `\n\nFrom the committee:\n${note}` : '';

const LETTER: Record<Decision, { subject: (f: LetterFacts) => string; body: (f: LetterFacts) => string }> = {
  accepted: {
    subject: (f) => `Your talk is on the program — ${f.eventName}`,
    body: (f) =>
      `“${f.title}” is on the program at ${from(f)}.` +
      said(f.note) +
      `\n\nWe will write again with your time and room. What we need from you, and when, is ` +
      `in your portal: ${f.portalUrl}`,
  },
  waitlisted: {
    subject: (f) => `Your talk is waitlisted — ${f.eventName}`,
    body: (f) =>
      `“${f.title}” is waitlisted for ${from(f)}. The committee wants it if space allows, and ` +
      `we will know by the week of the event.` +
      said(f.note) +
      `\n\nNothing is asked of you until then. If you would rather not hold the dates, you can ` +
      `withdraw it from your portal: ${f.portalUrl}`,
  },
  rejected: {
    subject: (f) => `Not this time — ${f.eventName}`,
    body: (f) =>
      `“${f.title}” did not make the program for ${f.eventName}.` +
      said(f.note) +
      `\n\nPlease send it again next year. Your proposal is still in your portal: ${f.portalUrl}`,
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
      `SELECT s.id, s.title, s.state, s.decision_version, s.event_id, e.name AS event_name,
              e.slug AS event_slug, e.starts_on, e.ends_on, p.person_id
         FROM submission s JOIN event e ON e.id = s.event_id
         JOIN participation p ON p.submission_id = s.id AND p.is_submitter = 1
        WHERE s.id = ? AND s.event_id = ?`
    )
    .bind(submissionId, eventId)
    .first<{
      id: string;
      title: string;
      state: string;
      decision_version: number;
      event_name: string;
      event_slug: string;
      starts_on: string;
      ends_on: string;
      person_id: string;
    }>();
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
  const facts: LetterFacts = {
    title: sub.title,
    eventName: sub.event_name,
    dates: eventDates(sub.starts_on, sub.ends_on),
    portalUrl: `${ORIGIN}/${sub.event_slug}/portal`,
    note,
  };

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
        letter.subject(facts),
        letter.body(facts),
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
