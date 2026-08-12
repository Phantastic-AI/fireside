// Telling is the second act. Release delivers every staged decision letter in
// one guarded, set-based transaction — the confirm's arithmetic, the pill,
// and the released rows can never differ by one. Email rides after the
// commit, real addresses only (R-12).
import { checkedBatch, guard, now } from '../lib/db';
import type { Principal } from './account';
import { isRealAddress } from './account';
import { requireDecider } from './decide';

export type ReleaseResult =
  | { ok: true; released: number; emailed: number }
  | { ok: false; error: string };

type EmailBinding = {
  send(msg: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
  }): Promise<unknown>;
};

/**
 * `expectedCount` is the number the human read on the confirm ("Send 610
 * decisions?"). If the pile moved since, the guard aborts and the screen asks
 * them to look again — the number a person confirms is the number that goes.
 */
export async function releaseDecisions(
  db: D1Database,
  principal: Principal,
  eventId: string,
  expectedCount: number,
  email: { binding: EmailBinding; from: string } | null,
  waitUntil: (p: Promise<unknown>) => void
): Promise<ReleaseResult> {
  requireDecider(principal, eventId);
  const t = now();

  // The cohort: staged decision letters whose version matches the proposal's
  // current decision — a stale letter can never release.
  const COHORT = `SELECT m.id AS message_id, m.submission_id FROM message m
    JOIN submission s ON s.id = m.submission_id
    WHERE m.event_id = ?1 AND m.kind = 'decision' AND m.delivered_at IS NULL
      AND m.decision_version = s.decision_version
      AND s.state IN ('accepted','waitlisted','rejected') AND s.notified_at IS NULL`;

  try {
    await checkedBatch(
      db,
      [
        guard(db, `SELECT 1 WHERE (SELECT COUNT(*) FROM (${COHORT})) <> ?2`, eventId, expectedCount),
        db
          .prepare(`UPDATE message SET delivered_at = ?2 WHERE id IN (SELECT message_id FROM (${COHORT}))`)
          .bind(eventId, t),
        db
          .prepare(
            `UPDATE submission SET notified_at = ?2 WHERE id IN (SELECT DISTINCT submission_id FROM message WHERE event_id = ?1 AND kind = 'decision' AND delivered_at = ?2)`
          )
          .bind(eventId, t),
      ],
      [0, expectedCount, 'any'],
      'The pile moved while you were reading. Look again, then send.'
    );
  } catch (e) {
    if (e instanceof Error && (e.name === 'StaleStateError' || e.name === 'ChangesMismatchError')) {
      return { ok: false, error: 'The pile moved while you were reading. Look again, then send.' };
    }
    throw e;
  }

  // After the commit: real addresses get real email. The synthetic cast never
  // leaves the building. Failures set nothing back — the portal is the log of
  // record; emailed_at records only what actually left.
  let emailed = 0;
  if (email) {
    const recipients = await db
      .prepare(
        `SELECT m.id, m.subject, m.body, p.email, p.name FROM message m
         JOIN person p ON p.id = m.person_id
         WHERE m.event_id = ?1 AND m.kind = 'decision' AND m.delivered_at = ?2 AND p.email IS NOT NULL`
      )
      .bind(eventId, t)
      .all<{ id: string; subject: string; body: string; email: string; name: string }>();
    const real = recipients.results.filter((r) => isRealAddress(r.email));
    emailed = real.length;
    waitUntil(
      (async () => {
        for (const r of real) {
          try {
            await email.binding.send({
              to: r.email,
              from: { email: email.from, name: 'Fireside' },
              subject: r.subject,
              text: `Hello ${r.name},\n\n${r.body}\n\n— sent from Fireside, where your portal always has the latest.`,
            });
            await db.prepare('UPDATE message SET emailed_at = ? WHERE id = ?').bind(now(), r.id).run();
          } catch {
            // the letter is delivered in the portal regardless; email is a copy
          }
        }
      })()
    );
  }

  return { ok: true, released: expectedCount, emailed };
}
