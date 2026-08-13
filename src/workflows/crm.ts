// Every write the speaker CRM makes (07), beside the bulk import in
// workflows/import.ts. One file, one register of acts: a note, a tag, a
// custom detail, a saved search, a card enrolled and moved through the
// sourcing board, a contact pushed onto an event's list, an invitation to
// submit, a note written to more than one contact at once, and a merge.
//
// The stage moves are the one act here with real staleness risk — two
// organizers dragging the same card is exactly the race checkedBatch exists
// for — so those two go through the guarded batch, the same discipline
// workflows/tasks.ts keeps. Everything else here is either a fresh row
// (nothing to race against) or an administrative reshuffle (the merge) that
// is its own kind of act and takes its own approach, described where it is.

import { checkedBatch, guard, newId, now, StaleStateError } from '../lib/db';
import {
  crmDirectory,
  directoryQueryString,
  requireOrg,
  PIPELINE_STAGES,
  type DirectoryOpts,
} from '../queries/crm';
import { EDIT_ROLES, requireScope } from '../queries/admin';
import type { Principal } from './account';

/* ------------------------------------------------------------------ *
 * A contact, added by hand rather than through the call or a CSV
 * ------------------------------------------------------------------ */

export type AddContactResult =
  | { ok: true; personId: string }
  | { ok: false; code: 'no-name' | 'no-email' | 'taken' | 'trouble' };

export async function addManualContact(
  db: D1Database,
  principal: Principal,
  input: { name: string; email: string; jobTitle?: string; organisation?: string; bio?: string }
): Promise<AddContactResult> {
  requireOrg(principal);
  const name = input.name.trim();
  if (!name) return { ok: false, code: 'no-name' };
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) return { ok: false, code: 'no-email' };

  const existing = await db.prepare('SELECT id FROM person WHERE email = ?').bind(email).first<{ id: string }>();
  if (existing) return { ok: false, code: 'taken' };

  const id = newId('per');
  try {
    await db
      .prepare(
        `INSERT INTO person (id, email, name, sort_name, job_title, organisation, bio, share_contact, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        id,
        email,
        name,
        name,
        input.jobTitle?.trim() || null,
        input.organisation?.trim() || null,
        input.bio?.trim() || null,
        '{}',
        now()
      )
      .run();
  } catch {
    return { ok: false, code: 'trouble' };
  }
  return { ok: true, personId: id };
}

/* ------------------------------------------------------------------ *
 * Notes, tags, and the one custom detail (CRM-03, CRM-04)
 * ------------------------------------------------------------------ */

export type WriteResult = { ok: true } | { ok: false; code: 'no-body' | 'not-found' | 'trouble' };

export async function addContactNote(
  db: D1Database,
  principal: Principal,
  personId: string,
  body: string
): Promise<WriteResult> {
  requireOrg(principal);
  const text = body.trim();
  if (!text) return { ok: false, code: 'no-body' };
  const person = await db
    .prepare('SELECT id FROM person WHERE id = ? AND merged_into_id IS NULL')
    .bind(personId)
    .first<{ id: string }>();
  if (!person) return { ok: false, code: 'not-found' };
  await db
    .prepare('INSERT INTO crm_note (id, owner_kind, owner_id, author_id, body, created_at) VALUES (?,?,?,?,?,?)')
    .bind(newId('crn'), 'person', personId, principal.personId, text, now())
    .run();
  return { ok: true };
}

export type SpeakerType = 'internal' | 'external';

export async function setSpeakerType(
  db: D1Database,
  principal: Principal,
  personId: string,
  value: SpeakerType | null
): Promise<{ ok: true } | { ok: false; code: 'not-found' }> {
  requireOrg(principal);
  const res = await db
    .prepare('UPDATE person SET speaker_type = ? WHERE id = ? AND merged_into_id IS NULL')
    .bind(value, personId)
    .run();
  if ((res.meta.changes ?? 0) === 0) return { ok: false, code: 'not-found' };
  return { ok: true };
}

export async function addTag(
  db: D1Database,
  principal: Principal,
  personId: string,
  tag: string
): Promise<{ ok: true } | { ok: false; code: 'no-tag' | 'not-found' }> {
  requireOrg(principal);
  const clean = tag.trim().slice(0, 40);
  if (!clean) return { ok: false, code: 'no-tag' };
  const person = await db
    .prepare('SELECT id FROM person WHERE id = ? AND merged_into_id IS NULL')
    .bind(personId)
    .first<{ id: string }>();
  if (!person) return { ok: false, code: 'not-found' };
  await db.prepare('INSERT OR IGNORE INTO crm_tag (person_id, tag) VALUES (?,?)').bind(personId, clean).run();
  return { ok: true };
}

export async function setLogistics(
  db: D1Database,
  principal: Principal,
  personId: string,
  text: string
): Promise<{ ok: true } | { ok: false; code: 'not-found' }> {
  requireOrg(principal);
  const value = text.trim() || null;
  const res = await db
    .prepare('UPDATE person SET logistics = ? WHERE id = ? AND merged_into_id IS NULL')
    .bind(value, personId)
    .run();
  if ((res.meta.changes ?? 0) === 0) return { ok: false, code: 'not-found' };
  return { ok: true };
}

/** The same write, reached from one event's own People screen instead of the
 *  org-level database — an event editor holds this without needing the
 *  install-wide organizer standing requireOrg asks for above (SPK-15). */
export async function setLogisticsForEvent(
  db: D1Database,
  principal: Principal,
  eventId: string,
  personId: string,
  text: string
): Promise<{ ok: true } | { ok: false; code: 'not-found' }> {
  requireScope(principal, eventId, EDIT_ROLES);
  const value = text.trim() || null;
  const res = await db
    .prepare('UPDATE person SET logistics = ? WHERE id = ? AND merged_into_id IS NULL')
    .bind(value, personId)
    .run();
  if ((res.meta.changes ?? 0) === 0) return { ok: false, code: 'not-found' };
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * A saved search — CRM-09. Saving one is naming the query string the
 * directory screen already built from its own form; there is no second
 * representation of a filter anywhere in this file.
 * ------------------------------------------------------------------ */

export type SegmentKind = 'dynamic' | 'curated';

export async function saveSegment(
  db: D1Database,
  principal: Principal,
  input: { name: string; kind: SegmentKind; opts: DirectoryOpts }
): Promise<{ ok: true; id: string } | { ok: false; code: 'no-name' | 'trouble' }> {
  requireOrg(principal);
  const name = input.name.trim();
  if (!name) return { ok: false, code: 'no-name' };

  const query = directoryQueryString(input.opts);
  let memberIds: string | null = null;
  if (input.kind === 'curated') {
    const d = await crmDirectory(db, principal, input.opts);
    memberIds = JSON.stringify(d.rows.map((r) => r.personId));
  }

  const id = newId('seg');
  try {
    await db
      .prepare(
        'INSERT INTO crm_segment (id, name, kind, query, member_ids, created_by, created_at) VALUES (?,?,?,?,?,?,?)'
      )
      .bind(id, name, input.kind, query, memberIds, principal.personId, now())
      .run();
  } catch {
    return { ok: false, code: 'trouble' };
  }
  return { ok: true, id };
}

/* ------------------------------------------------------------------ *
 * The sourcing board — CRM-07, CRM-08
 * ------------------------------------------------------------------ */

export type CardResult = { ok: true; cardId: string } | { ok: false; code: 'not-found' | 'exists' | 'trouble' };

export async function enrollInPipeline(
  db: D1Database,
  principal: Principal,
  personId: string,
  input: { stage?: string; score?: number | null; rationale?: string | null }
): Promise<CardResult> {
  requireOrg(principal);
  const stage = PIPELINE_STAGES.some((s) => s.value === input.stage) ? (input.stage as string) : 'identified';

  const person = await db
    .prepare('SELECT id FROM person WHERE id = ? AND merged_into_id IS NULL')
    .bind(personId)
    .first<{ id: string }>();
  if (!person) return { ok: false, code: 'not-found' };
  const already = await db.prepare('SELECT id FROM crm_card WHERE person_id = ?').bind(personId).first<{ id: string }>();
  if (already) return { ok: false, code: 'exists' };

  const score =
    typeof input.score === 'number' && Number.isFinite(input.score)
      ? Math.min(100, Math.max(0, Math.round(input.score)))
      : null;
  const rationale = input.rationale?.trim() || null;
  const cardId = newId('crd');
  const t = now();

  try {
    await checkedBatch(
      db,
      [
        db
          .prepare(
            'INSERT INTO crm_card (id, person_id, stage, score, rationale, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
          )
          .bind(cardId, personId, stage, score, rationale, t, t),
        db
          .prepare('INSERT INTO crm_card_event (id, card_id, from_stage, to_stage, created_at) VALUES (?,?,NULL,?,?)')
          .bind(newId('cev'), cardId, stage, t),
      ],
      [1, 1],
      'that card was already on the board'
    );
  } catch {
    return { ok: false, code: 'trouble' };
  }
  return { ok: true, cardId };
}

export type MoveResult = { ok: true } | { ok: false; code: 'moved' | 'bad-stage' | 'trouble' };

/**
 * Move a card to another stage, guarded on the stage the screen actually
 * read: `fromStage` is what the card was showing a moment ago, and the write
 * only lands if that is still true — the same "what you confirmed is what
 * happens" rule the outbox holds its own counts to.
 */
export async function moveCardStage(
  db: D1Database,
  principal: Principal,
  cardId: string,
  fromStage: string,
  toStage: string
): Promise<MoveResult> {
  requireOrg(principal);
  if (!PIPELINE_STAGES.some((s) => s.value === toStage)) return { ok: false, code: 'bad-stage' };
  const t = now();
  try {
    await checkedBatch(
      db,
      [
        guard(db, 'SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM crm_card WHERE id = ?1 AND stage = ?2)', cardId, fromStage),
        db.prepare('UPDATE crm_card SET stage = ?, updated_at = ? WHERE id = ? AND stage = ?').bind(toStage, t, cardId, fromStage),
        db
          .prepare('INSERT INTO crm_card_event (id, card_id, from_stage, to_stage, created_at) VALUES (?,?,?,?,?)')
          .bind(newId('cev'), cardId, fromStage, toStage, t),
      ],
      [0, 1, 1],
      'that card moved while you were looking'
    );
  } catch (e) {
    if (e instanceof StaleStateError || (e instanceof Error && e.name === 'ChangesMismatchError')) {
      return { ok: false, code: 'moved' };
    }
    return { ok: false, code: 'trouble' };
  }
  return { ok: true };
}

export async function addCardNote(
  db: D1Database,
  principal: Principal,
  cardId: string,
  body: string
): Promise<WriteResult> {
  requireOrg(principal);
  const text = body.trim();
  if (!text) return { ok: false, code: 'no-body' };
  const card = await db.prepare('SELECT id FROM crm_card WHERE id = ?').bind(cardId).first<{ id: string }>();
  if (!card) return { ok: false, code: 'not-found' };
  await db
    .prepare('INSERT INTO crm_note (id, owner_kind, owner_id, author_id, body, created_at) VALUES (?,?,?,?,?,?)')
    .bind(newId('crn'), 'card', cardId, principal.personId, text, now())
    .run();
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Reaching into one event — CRM-10, plus the "invite to submit" gesture
 * ------------------------------------------------------------------ */

export type ReachResult = { ok: true } | { ok: false; code: 'not-found' | 'trouble' };

/** Push a contact onto one event's list, with nothing re-typed: the same
 *  roster_entry fact CSV import writes, source-tagged 'crm' instead of
 *  'import' so a reader can always tell where somebody's place on a list
 *  came from. */
export async function addToEvent(
  db: D1Database,
  principal: Principal,
  personId: string,
  eventId: string
): Promise<ReachResult> {
  requireOrg(principal);
  const person = await db
    .prepare('SELECT id FROM person WHERE id = ? AND merged_into_id IS NULL')
    .bind(personId)
    .first<{ id: string }>();
  if (!person) return { ok: false, code: 'not-found' };
  try {
    await db
      .prepare(
        `INSERT INTO roster_entry (id, event_id, person_id, source, created_at) VALUES (?,?,?,'crm',?)
         ON CONFLICT (event_id, person_id) DO NOTHING`
      )
      .bind(newId('ros'), eventId, personId, now())
      .run();
  } catch {
    return { ok: false, code: 'trouble' };
  }
  return { ok: true };
}

/**
 * Invite one contact to the current call: push them onto the event's list
 * (so they are there to find the moment they answer) and write them a
 * personal, one-recipient note — the same 'note' kind and the same staged/
 * send/history path workflows/tasks.ts's stageNotes already built, so the
 * organizer sends it from the one outbox they already know, not a second
 * one this screen invented. The letter names the call honestly: it links to
 * the public page rather than claiming anything on that page is pre-filled,
 * because nothing is.
 */
export async function inviteToSubmit(
  db: D1Database,
  principal: Principal,
  event: { id: string; name: string },
  personId: string,
  cfpUrl: string
): Promise<ReachResult> {
  requireOrg(principal);
  const person = await db
    .prepare('SELECT id, name FROM person WHERE id = ? AND merged_into_id IS NULL')
    .bind(personId)
    .first<{ id: string; name: string }>();
  if (!person) return { ok: false, code: 'not-found' };

  try {
    await db
      .prepare(
        `INSERT INTO roster_entry (id, event_id, person_id, source, created_at) VALUES (?,?,?,'crm',?)
         ON CONFLICT (event_id, person_id) DO NOTHING`
      )
      .bind(newId('ros'), event.id, personId, now())
      .run();

    const first = person.name.trim().split(/\s+/)[0] ?? person.name;
    const subject = `Speak at ${event.name}?`;
    const body =
      `${first}, we would like to see a proposal from you for ${event.name}. ` +
      `The call for speakers is open here:\n\n${cfpUrl}`;
    await db
      .prepare(`INSERT INTO message (id, event_id, person_id, kind, subject, body, created_at) VALUES (?,?,?,'note',?,?,?)`)
      .bind(newId('msg'), event.id, personId, subject, body, now())
      .run();
  } catch {
    return { ok: false, code: 'trouble' };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Writing to more than one contact at once — CRM-11
 * ------------------------------------------------------------------ */

/** Fill {{first_name}} and {{event}} — the two tokens the composer offers.
 *  An unknown token is left exactly as typed rather than silently dropped,
 *  so a typo in a token name is visible in the preview, not swallowed by it. */
export function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in values ? values[k]! : m));
}

export type BulkPreviewRow = { personId: string; name: string; resolvedBody: string };

export function previewBulkTemplate(
  contacts: { personId: string; name: string }[],
  bodyTemplate: string,
  eventName: string
): BulkPreviewRow[] {
  return contacts.map((c) => ({
    personId: c.personId,
    name: c.name,
    resolvedBody: fillTemplate(bodyTemplate, {
      first_name: c.name.trim().split(/\s+/)[0] ?? c.name,
      event: eventName,
    }),
  }));
}

export type BulkResult =
  | { ok: true; staged: number }
  | { ok: false; code: 'no-recipients' | 'no-subject' | 'no-body' | 'trouble' };

export async function crmBulkEmail(
  db: D1Database,
  principal: Principal,
  event: { id: string; name: string },
  contacts: { personId: string; name: string }[],
  subject: string,
  bodyTemplate: string
): Promise<BulkResult> {
  requireOrg(principal);
  if (contacts.length === 0) return { ok: false, code: 'no-recipients' };
  const subj = subject.trim();
  if (!subj) return { ok: false, code: 'no-subject' };
  const tmpl = bodyTemplate.trim();
  if (!tmpl) return { ok: false, code: 'no-body' };

  const t = now();
  try {
    for (const row of previewBulkTemplate(contacts, tmpl, event.name)) {
      await db
        .prepare(`INSERT INTO message (id, event_id, person_id, kind, subject, body, created_at) VALUES (?,?,?,'note',?,?,?)`)
        .bind(newId('msg'), event.id, row.personId, subj, row.resolvedBody, t)
        .run();
    }
  } catch {
    return { ok: false, code: 'trouble' };
  }
  return { ok: true, staged: contacts.length };
}

/* ------------------------------------------------------------------ *
 * Merging a duplicate — CRM-06
 *
 * The losing record is never deleted (0008's own comment on merged_into_id
 * says why: a task, a message, or a review may already point at its id).
 * Every table that names a person is walked once, in the order a foreign
 * key would fail first if this ever ran out of order: participation, task,
 * notes, tags, roster entries, and the one sourcing card a person may hold.
 * Not a checkedBatch — there is no single "the world moved" precondition
 * for an administrative reshuffle across six tables to guard on, the same
 * reasoning reseed.ts's own sequential writes already rest on.
 * ------------------------------------------------------------------ */

export type MergeResult = { ok: true } | { ok: false; code: 'not-found' | 'same' | 'trouble' };

export async function mergeContacts(
  db: D1Database,
  principal: Principal,
  primaryId: string,
  secondaryId: string
): Promise<MergeResult> {
  requireOrg(principal);
  if (primaryId === secondaryId) return { ok: false, code: 'same' };

  const [primary, secondary] = await Promise.all([
    db
      .prepare('SELECT id, job_title, organisation, bio, phone, logistics FROM person WHERE id = ? AND merged_into_id IS NULL')
      .bind(primaryId)
      .first<{
        id: string;
        job_title: string | null;
        organisation: string | null;
        bio: string | null;
        phone: string | null;
        logistics: string | null;
      }>(),
    db.prepare('SELECT id FROM person WHERE id = ? AND merged_into_id IS NULL').bind(secondaryId).first<{ id: string }>(),
  ]);
  if (!primary || !secondary) return { ok: false, code: 'not-found' };

  try {
    // Fill only what the primary does not already say — the primary's own
    // words, wherever it has them, are never replaced.
    const src = await db
      .prepare('SELECT job_title, organisation, bio, phone, logistics FROM person WHERE id = ?')
      .bind(secondaryId)
      .first<{ job_title: string | null; organisation: string | null; bio: string | null; phone: string | null; logistics: string | null }>();
    if (src) {
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (!primary.job_title && src.job_title) {
        sets.push('job_title = ?');
        vals.push(src.job_title);
      }
      if (!primary.organisation && src.organisation) {
        sets.push('organisation = ?');
        vals.push(src.organisation);
      }
      if (!primary.bio && src.bio) {
        sets.push('bio = ?');
        vals.push(src.bio);
      }
      if (!primary.phone && src.phone) {
        sets.push('phone = ?');
        vals.push(src.phone);
      }
      if (!primary.logistics && src.logistics) {
        sets.push('logistics = ?');
        vals.push(src.logistics);
      }
      if (sets.length > 0) {
        await db
          .prepare(`UPDATE person SET ${sets.join(', ')} WHERE id = ?`)
          .bind(...vals, primaryId)
          .run();
      }
    }

    await db.prepare('UPDATE participation SET person_id = ? WHERE person_id = ?').bind(primaryId, secondaryId).run();
    await db.prepare('UPDATE task SET person_id = ? WHERE person_id = ?').bind(primaryId, secondaryId).run();
    await db
      .prepare(`UPDATE crm_note SET owner_id = ? WHERE owner_kind = 'person' AND owner_id = ?`)
      .bind(primaryId, secondaryId)
      .run();
    await db
      .prepare('INSERT OR IGNORE INTO crm_tag (person_id, tag) SELECT ?, tag FROM crm_tag WHERE person_id = ?')
      .bind(primaryId, secondaryId)
      .run();
    await db.prepare('DELETE FROM crm_tag WHERE person_id = ?').bind(secondaryId).run();

    const rosterRows = await db
      .prepare('SELECT event_id FROM roster_entry WHERE person_id = ?')
      .bind(secondaryId)
      .all<{ event_id: string }>();
    for (const r of rosterRows.results) {
      await db
        .prepare(
          `INSERT INTO roster_entry (id, event_id, person_id, source, created_at) VALUES (?,?,?,'crm',?)
           ON CONFLICT (event_id, person_id) DO NOTHING`
        )
        .bind(newId('ros'), r.event_id, primaryId, now())
        .run();
    }
    await db.prepare('DELETE FROM roster_entry WHERE person_id = ?').bind(secondaryId).run();

    // A sourcing card is UNIQUE per person — the secondary's card moves over
    // only when the primary does not already hold one of its own.
    const primaryCard = await db.prepare('SELECT id FROM crm_card WHERE person_id = ?').bind(primaryId).first<{ id: string }>();
    if (!primaryCard) {
      await db.prepare('UPDATE crm_card SET person_id = ? WHERE person_id = ?').bind(primaryId, secondaryId).run();
    }

    await db.prepare('UPDATE person SET merged_into_id = ? WHERE id = ?').bind(primaryId, secondaryId).run();
  } catch {
    return { ok: false, code: 'trouble' };
  }
  return { ok: true };
}
