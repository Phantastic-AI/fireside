// T606 — the AI first read (ABS-14's zero, killed).
//
// A first-pass read of the submitted pile: for each proposal, a score on each
// of the round's numeric criteria and two or three written sentences that cite
// the abstract's own subject matter. Three laws keep it honest:
//
//   1. NOTHING RUNS UNSOLICITED. There is no toggle that quietly reads piles
//      in the night — a decider presses "Run the AI first read", the press is
//      capped, and a proposal already read this round is never read again
//      (UNIQUE submission+round). Explicit, bounded, idempotent.
//   2. THE MACHINE'S NUMBER IS NEVER A HUMAN'S. First reads live in their own
//      table, render in their own labeled column and card, and are never
//      averaged into the committee's number. An organizer's override sits
//      BESIDE the machine's score — attributed, timestamped, and the
//      machine's original stays visible under it.
//   3. IT IS AN ANNOTATION, NEVER AN ACTION. A first read stages nothing,
//      decides nothing, and writes to nobody. It exists to order a chair's
//      evening reading, not to shorten it.

import { newId, now } from '../lib/db';
import { requireScope, EDIT_ROLES } from '../queries/admin';
import { scorecardFor, type ScorecardKey } from '../queries/reviews';
import type { Principal } from './account';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const PATIENCE_MS = 20_000;
/** The most proposals one press reads — a bounded act, pressed again for more. */
export const FIRST_READ_BATCH = 25;

export type FirstRead = {
  submissionId: string;
  round: number;
  scores: Record<string, number>;
  rationale: string;
  model: string;
  createdAt: number;
  overrideScore: number | null;
  overrideBy: string | null;
  overrideAt: number | null;
};

type FirstReadRow = {
  submission_id: string;
  round: number;
  scores: string;
  rationale: string;
  model: string;
  created_at: number;
  override_score: number | null;
  override_by: string | null;
  override_at: number | null;
};

function ofRow(r: FirstReadRow): FirstRead {
  let scores: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(r.scores);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number' && Number.isFinite(v)) scores[k] = v;
      }
    }
  } catch {
    scores = {};
  }
  return {
    submissionId: r.submission_id,
    round: r.round,
    scores,
    rationale: r.rationale,
    model: r.model,
    createdAt: r.created_at,
    overrideScore: r.override_score,
    overrideBy: r.override_by,
    overrideAt: r.override_at,
  };
}

/** Every first read this event's round holds, keyed by submission. */
export async function firstReadsFor(
  db: D1Database,
  eventId: string,
  round: number
): Promise<Map<string, FirstRead>> {
  const res = await db
    .prepare(
      `SELECT fr.submission_id, fr.round, fr.scores, fr.rationale, fr.model, fr.created_at,
              fr.override_score, fr.override_by, fr.override_at
         FROM first_read fr
         JOIN submission s ON s.id = fr.submission_id
        WHERE s.event_id = ?1 AND fr.round = ?2`
    )
    .bind(eventId, round)
    .all<FirstReadRow>();
  return new Map((res.results ?? []).map((r) => [r.submission_id, ofRow(r)]));
}

/** The machine's own average across the round's numeric criteria — plain,
 *  unweighted, and shown only in the column that says whose it is. */
export function firstReadAverage(fr: FirstRead, card: readonly ScorecardKey[]): number | null {
  const nums = card.filter((k) => k.kind === 'scale').map((k) => fr.scores[k.key]);
  const present = nums.filter((n): n is number => typeof n === 'number');
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

type AiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

/** The strict shape the model is asked for, and the only shape believed. */
function extractJson(text: string): { scores: Record<string, number>; rationale: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    const rationale = typeof o.rationale === 'string' ? o.rationale.trim().slice(0, 1200) : '';
    const scores: Record<string, number> = {};
    if (typeof o.scores === 'object' && o.scores !== null && !Array.isArray(o.scores)) {
      for (const [k, v] of Object.entries(o.scores as Record<string, unknown>)) {
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isFinite(n)) scores[k] = n;
      }
    }
    if (!rationale || Object.keys(scores).length === 0) return null;
    return { scores, rationale };
  } catch {
    return null;
  }
}

const SYSTEM =
  'You are the first reader for a conference program committee. You read one proposal and ' +
  'return STRICT JSON only, no prose around it: {"scores": {<criterion key>: <integer>}, ' +
  '"rationale": "<two or three sentences>"}. Score every numeric criterion you are given, ' +
  'within its stated maximum. The rationale must cite the proposal’s own specifics — ' +
  'its subject matter, claims, or evidence — never boilerplate that could describe any talk.';

type PileRow = {
  id: string;
  title: string;
  abstract: string | null;
  format: string;
  level: string | null;
  track_name: string | null;
};

export type FirstReadRun = {
  read: number;
  already: number;
  failed: number;
  remaining: number;
};

/**
 * One press: read up to FIRST_READ_BATCH submitted proposals that have no
 * first read this round. Failures (a slow model, an unparseable reply) skip
 * the proposal and say so in the count; the next press retries them.
 */
export async function runFirstReads(
  db: D1Database,
  ai: AiBinding,
  principal: Principal,
  eventId: string,
  round: number
): Promise<FirstReadRun> {
  requireScope(principal, eventId, EDIT_ROLES);
  const card = await db
    .prepare('SELECT round_scorecards FROM event WHERE id = ?')
    .bind(eventId)
    .first<{ round_scorecards: string }>();
  const criteria = scorecardFor(card?.round_scorecards ?? '{}', round).filter(
    (k) => k.kind === 'scale'
  );

  const pile = await db
    .prepare(
      `SELECT s.id, s.title, s.abstract, s.format, s.level, t.name AS track_name
         FROM submission s
         LEFT JOIN track t ON t.id = s.track_id
        WHERE s.event_id = ?1 AND s.state = 'submitted'
          AND NOT EXISTS (SELECT 1 FROM first_read fr
                           WHERE fr.submission_id = s.id AND fr.round = ?2)
        ORDER BY s.submitted_at, s.id
        LIMIT ?3`
    )
    .bind(eventId, round, FIRST_READ_BATCH + 1)
    .all<PileRow>();
  const rows = (pile.results ?? []).slice(0, FIRST_READ_BATCH);
  const more = (pile.results ?? []).length > FIRST_READ_BATCH;

  let read = 0;
  let failed = 0;
  for (const s of rows) {
    const user =
      `Criteria (score each, integers only):\n` +
      criteria.map((k) => `- ${k.key}: "${k.label}" (0 to ${k.max})`).join('\n') +
      `\n\nProposal:\nTitle: ${s.title}\nFormat: ${s.format}` +
      (s.track_name ? `\nTrack: ${s.track_name}` : '') +
      (s.level ? `\nPitched at: ${s.level}` : '') +
      `\nAbstract: ${s.abstract ?? '(none given)'}`;
    try {
      const call = ai.run(MODEL, {
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        max_tokens: 400,
        temperature: 0.2,
      });
      const patience = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('slow')), PATIENCE_MS)
      );
      const result = (await Promise.race([call, patience])) as {
        response?: unknown;
        choices?: { message?: { content?: unknown } }[];
      };
      const raw = result?.choices?.[0]?.message?.content ?? result?.response;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
      const parsed = extractJson(text);
      if (!parsed) {
        failed += 1;
        continue;
      }
      // Clamp to each criterion's own scale; drop keys the card never had.
      const kept: Record<string, number> = {};
      for (const k of criteria) {
        const n = parsed.scores[k.key];
        if (typeof n === 'number') kept[k.key] = Math.max(0, Math.min(k.max, Math.round(n)));
      }
      if (Object.keys(kept).length === 0) {
        failed += 1;
        continue;
      }
      await db
        .prepare(
          `INSERT INTO first_read (id, submission_id, round, scores, rationale, model, created_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT (submission_id, round) DO NOTHING`
        )
        .bind(
          newId('fr'),
          s.id,
          round,
          JSON.stringify(kept),
          parsed.rationale,
          MODEL,
          now()
        )
        .run();
      read += 1;
    } catch {
      failed += 1;
    }
  }
  return { read, already: 0, failed, remaining: more ? 1 : 0 };
}

export type OverrideOutcome = 'saved' | 'cleared' | 'gone' | 'refused';

/**
 * The human's number beside the machine's. `score` null clears the override;
 * either way the machine's original stays on the row, visibly labeled.
 */
export async function overrideFirstRead(
  db: D1Database,
  principal: Principal,
  eventId: string,
  submissionId: string,
  round: number,
  score: number | null
): Promise<OverrideOutcome> {
  requireScope(principal, eventId, EDIT_ROLES);
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) return 'refused';
  const res = await db
    .prepare(
      `UPDATE first_read SET override_score = ?4, override_by = ?5, override_at = ?6
        WHERE submission_id = ?1 AND round = ?2
          AND EXISTS (SELECT 1 FROM submission s WHERE s.id = ?1 AND s.event_id = ?3)`
    )
    .bind(
      submissionId,
      round,
      eventId,
      score,
      score === null ? null : principal.personId,
      score === null ? null : now()
    )
    .run();
  if ((res.meta?.changes ?? 0) === 0) return 'gone';
  return score === null ? 'cleared' : 'saved';
}
