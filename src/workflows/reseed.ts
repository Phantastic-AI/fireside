// R-2 (revised): reseed is a SURGICAL deterministic rebuild. It flushes only
// what the seed owns — the demo conferences and the fixture cast — and
// re-inserts the world from seed.ts. Everything a real customer created under
// their own sign-up (their account, their conference, every row beneath it)
// survives the rebuild untouched; that includes a judge's own experiments.
// Fixture people are reset in place (upsert), never deleted, so a real
// conference that references one — a fixture prospect pushed onto a real
// roster — keeps its footing across the nightly rebuild.
import { buildSeed, assertDistribution, type SeedData, type Row } from '../../seed/seed';
import { hashPassword, saltFrom } from '../lib/sign';

// The published organizer credential (R-3): printed in the README, made safe
// by this very rebuild. Deterministic salt keeps the hash stable across runs.
// Δ conn adds two more (report to the doc owner: publish both in the README
// alongside naomi's, the same deployment invariant) — a judge needs to be
// signed in as each side of a pair to watch a live request/accept/revoke,
// not just read the seeded-accepted one between them.
const DEMO_CREDENTIALS: [personId: string, password: string][] = [
  ['naomi-adeyemi', 'read-them-before-they-go'],
  ['dani-okafor', 'ask-before-you-assume'],
  ['per-reciprocal-attendee', 'accept-what-you-choose'],
  // Priya's helper — so a judge can sign in as the assistant and see the
  // scoped portal (upload the deck, mark a task; never withdraw the talk).
  ['devika-nair', 'the-deck-is-handled'],
  // The reviewer — so a judge can sign in and work the blind review queue, the
  // sixth representative role. Publish alongside the others in the README.
  ['lena-fischer', 'score-what-you-read'],
];

// Reverse-FK wipe order; forward order for inserts. 'file' and 'file_comment'
// sit right after 'task' — a file's r2_key names the task it belongs to, and
// a comment's task_id references it directly, so both need the row to exist
// first.
const INSERT_ORDER: (keyof SeedData)[] = [
  'event', 'person', 'track', 'room', 'submission', 'participation', 'review',
  'event_role', 'task', 'file', 'file_comment', 'message', 'my_schedule', 'star',
  'connection', 'friend_request', 'speaker_helper', 'speaker_follow', 'question', 'answer',
  // CRM tables last, so the reverse-order wipe deletes these children before
  // their person/event parents. Seeded empty; present here only to be cleared.
  'roster_entry', 'crm_note', 'crm_tag', 'crm_segment', 'crm_card', 'crm_card_event',
];
// ------------------------------------------------------------------
// The surgical wipe. Three scoped passes replace the old DELETE-everything:
//
//   1. eventTreeDeletes(id)  — one event's whole tree, children before
//      parents. Run per demo event by reseed, and per real event by the
//      /__cp0/drop door (a gedanken torn down on purpose is the same shape
//      as a demo rebuilt on schedule).
//   2. fixtureDeletes()      — rows keyed to fixture PEOPLE rather than to a
//      demo event: their CRM residue, connections, follows, the counters.
//      "Demo" for a sourcing card means its creator is fixture (or unknown,
//      for rows older than the created_by column).
//   3. person upsert         — fixture people reset in place, never deleted,
//      so real rows that reference them keep their footing.
// ------------------------------------------------------------------

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Every DELETE that empties ONE event's tree, children before parents. */
function eventTreeDeletes(db: D1Database, eventId: string): D1PreparedStatement[] {
  const E = (sql: string) => db.prepare(sql).bind(eventId);
  const SSUB = 'SELECT id FROM submission WHERE event_id = ?1';
  const STASK = 'SELECT id FROM task WHERE event_id = ?1';
  return [
    E('DELETE FROM pending_action WHERE event_id = ?1'),
    E('DELETE FROM agent_audit WHERE event_id = ?1'),
    E(`DELETE FROM reply_ticket WHERE task_id IN (${STASK})`),
    E('DELETE FROM embedding WHERE event_id = ?1'),
    E(`DELETE FROM neighbor WHERE submission_id IN (${SSUB})`),
    E(`DELETE FROM first_read WHERE submission_id IN (${SSUB})`),
    E('DELETE FROM matrix_cache WHERE event_id = ?1'),
    E('DELETE FROM theme_cache WHERE event_id = ?1'),
    E(`DELETE FROM revision WHERE owner_kind = 'submission' AND owner_id IN (${SSUB})`),
    E("DELETE FROM revision WHERE owner_kind = 'message' AND owner_id IN (SELECT id FROM message WHERE event_id = ?1)"),
    E("DELETE FROM revision WHERE owner_kind = 'answer' AND owner_id IN (SELECT id FROM answer WHERE event_id = ?1)"),
    E('DELETE FROM roster_entry WHERE event_id = ?1'),
    E('DELETE FROM star WHERE my_schedule_id IN (SELECT id FROM my_schedule WHERE event_id = ?1)'),
    E(`DELETE FROM connection WHERE submission_id IN (${SSUB})`),
    E('DELETE FROM friend_request WHERE event_id = ?1'),
    E('DELETE FROM speaker_follow WHERE origin_event_id = ?1'),
    E('DELETE FROM speaker_helper WHERE event_id = ?1'),
    E('DELETE FROM my_schedule WHERE event_id = ?1'),
    E("DELETE FROM file WHERE owner_kind = 'submission' AND owner_id IN (" + SSUB + ')'),
    E("DELETE FROM file WHERE owner_kind = 'event' AND owner_id = ?1"),
    E(`DELETE FROM file_comment WHERE task_id IN (${STASK})`),
    E('DELETE FROM answer WHERE event_id = ?1'),
    E('DELETE FROM question WHERE event_id = ?1'),
    E('DELETE FROM message WHERE event_id = ?1'),
    E('DELETE FROM task WHERE event_id = ?1'),
    E('DELETE FROM event_role WHERE event_id = ?1'),
    E(`DELETE FROM review WHERE submission_id IN (${SSUB})`),
    E(`DELETE FROM participation WHERE submission_id IN (${SSUB})`),
    E('DELETE FROM submission WHERE event_id = ?1'),
    E('DELETE FROM room WHERE event_id = ?1'),
    E('DELETE FROM track WHERE event_id = ?1'),
    E('DELETE FROM event WHERE id = ?1'),
  ];
}

/** Rows keyed to fixture PEOPLE rather than to a demo event: CRM residue
 *  (a card is demo when its creator is fixture or unknown), the social
 *  graph around fixture people, person-owned files, and the counters. */
function fixtureDeletes(db: D1Database): D1PreparedStatement[] {
  const SP = '(SELECT id FROM _seed_person)';
  const DEMO_CARDS = `(SELECT id FROM crm_card WHERE created_by IS NULL OR created_by IN ${SP})`;
  return [
    db.prepare(`DELETE FROM pending_action WHERE person_id IN ${SP}`),
    db.prepare(`DELETE FROM agent_audit WHERE person_id IN ${SP}`),
    db.prepare(
      `DELETE FROM crm_note WHERE author_id IN ${SP} OR (owner_kind = 'card' AND owner_id IN ${DEMO_CARDS})`
    ),
    db.prepare(`DELETE FROM crm_card_event WHERE card_id IN ${DEMO_CARDS}`),
    db.prepare(`DELETE FROM crm_card WHERE created_by IS NULL OR created_by IN ${SP}`),
    db.prepare(`DELETE FROM crm_tag WHERE person_id IN ${SP}`),
    db.prepare(`DELETE FROM crm_segment WHERE created_by IN ${SP}`),
    db.prepare(`DELETE FROM connection WHERE owner_person_id IN ${SP} OR other_person_id IN ${SP}`),
    db.prepare(`DELETE FROM friend_request WHERE requester_id IN ${SP} OR recipient_id IN ${SP}`),
    db.prepare(`DELETE FROM speaker_follow WHERE follower_person_id IN ${SP} OR speaker_person_id IN ${SP}`),
    db.prepare(`DELETE FROM file WHERE owner_kind = 'person' AND owner_id IN ${SP}`),
    db.prepare('DELETE FROM ai_budget'),
    db.prepare('DELETE FROM _guard'),
  ];
}

/* ------------------------------------------------------------------ *
 * CNT-04/CNT-13/CNT-14 — the demo world's decks are real files, not just a
 * completed_at flag. seed.ts stays pure data (no I/O, deterministic by
 * construction); this is the one place that turns a seeded file row into
 * actual bytes, computed from the row itself so the PDF's xref offsets are
 * always correct rather than hand-typed and hoped-for.
 * ------------------------------------------------------------------ */

function buildDemoPdf(lines: string[]): Uint8Array {
  const escText = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = lines
    .map((line, i) => `BT /F1 18 Tf 72 ${700 - i * 28} Td (${escText(line)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(body);
}

const MAX_PARAMS = 90;
const MAX_STATEMENTS = 40;

// Runtime person columns the seed does not carry: an upserted fixture person
// gets them reset to NULL so a judge's password, Google link, headshot or
// merge experiment on a fixture account never outlives the night.
const PERSON_RESET = [
  'password_hash', 'google_sub', 'headshot_file_id', 'last_signed_in_at',
  'speaker_type', 'logistics', 'merged_into_id',
];

function insertStatements(
  db: D1Database,
  table: string,
  rows: Row[],
  upsertOnId = false
): D1PreparedStatement[] {
  if (rows.length === 0) return [];
  const first = rows[0];
  if (!first) return [];
  const cols = Object.keys(first);
  const perChunk = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
  const conflict = upsertOnId
    ? ` ON CONFLICT(id) DO UPDATE SET ${cols
        .filter((c) => c !== 'id')
        .map((c) => `${c}=excluded.${c}`)
        .concat(PERSON_RESET.map((c) => `${c}=NULL`))
        .join(',')}`
    : '';
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const placeholders = chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${placeholders}${conflict}`;
    const bindings = chunk.flatMap((r) => cols.map((c) => r[c] ?? null));
    out.push(db.prepare(sql).bind(...bindings));
  }
  return out;
}

export async function reseed(
  db: D1Database,
  bucket: R2Bucket
): Promise<{ facts: string; inserted: Record<string, number>; ms: number }> {
  const t0 = Date.now();
  const data = buildSeed();
  const facts = assertDistribution(data); // refuse to wipe if the new world is wrong

  // Every seeded file row gets its own real PDF, built here so its declared
  // size is always the true one — no hand-typed byte count to drift from the
  // bytes it actually names. The words on the page say which version it is,
  // so a judge opening one from the library sees more than a blank sheet.
  const pdfByKey = new Map<string, Uint8Array>();
  for (const row of data.file) {
    const filename = String(row['filename'] ?? 'file.pdf');
    const r2Key = String(row['r2_key'] ?? '');
    const which = filename === 'slides-draft.pdf' ? 'Draft — an earlier version' : 'Final deck';
    const bytes = buildDemoPdf(['Fireside demo deck', which, filename]);
    pdfByKey.set(r2Key, bytes);
    row['size_bytes'] = bytes.byteLength;
  }

  // Refresh the fixture manifest first: the scoped deletes below say
  // "IN (SELECT id FROM _seed_person)" against it. CREATE IF NOT EXISTS is
  // defensive; schema/0016 is the canonical definition.
  const personIds = data.person.map((r) => String(r['id']));
  const manifest: D1PreparedStatement[] = [
    db.prepare('CREATE TABLE IF NOT EXISTS _seed_person (id TEXT PRIMARY KEY)'),
    db.prepare('DELETE FROM _seed_person'),
    ...chunk(personIds, 80).map((ids) =>
      db.prepare(`INSERT INTO _seed_person (id) VALUES ${ids.map(() => '(?)').join(',')}`).bind(...ids)
    ),
  ];
  await db.batch(manifest);

  // The surgical wipe: each demo event's tree, then the fixture-people pass.
  // Real events, real people, and everything beneath them are never named.
  const wipe: D1PreparedStatement[] = [];
  for (const ev of data.event) wipe.push(...eventTreeDeletes(db, String(ev['id'])));
  wipe.push(...fixtureDeletes(db));
  for (const part of chunk(wipe, MAX_STATEMENTS)) await db.batch(part);

  const inserted: Record<string, number> = {};
  let pending: D1PreparedStatement[] = [];
  for (const table of INSERT_ORDER) {
    const rows = data[table];
    inserted[table] = rows.length;
    // Fixture people are upserted in place — a real conference that references
    // one (a fixture prospect on a real roster) must keep its footing.
    for (const stmt of insertStatements(db, table, rows, table === 'person')) {
      pending.push(stmt);
      if (pending.length >= MAX_STATEMENTS) {
        await db.batch(pending);
        pending = [];
      }
    }
  }
  if (pending.length) await db.batch(pending);

  // R2 and D1 share no transaction (workflows/files.ts's own rule): the rows
  // are already in place, so a bucket that is slow or briefly unavailable
  // leaves a file row with nothing behind it rather than the other way
  // around — the same failure shape an organizer's own upload can leave, and
  // the one this product already knows how to describe.
  for (const [key, bytes] of pdfByKey) {
    await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  }

  for (const [personId, password] of DEMO_CREDENTIALS) {
    const hash = await hashPassword(password, saltFrom(personId));
    await db.prepare('UPDATE person SET password_hash = ? WHERE id = ?').bind(hash, personId).run();
  }

  return { facts, inserted, ms: Date.now() - t0 };
}

/* ------------------------------------------------------------------ *
 * The drop door: tear down ONE real event's whole tree — a gedanken reset,
 * so the same story can be conducted again from a clean floor. Refuses the
 * demo conferences (reseed owns those), deletes the event's R2 files too.
 * ------------------------------------------------------------------ */

export async function dropEvent(
  db: D1Database,
  bucket: R2Bucket,
  slugv: string
): Promise<{ ok: boolean; code?: string; dropped?: string; files?: number }> {
  const ev = await db
    .prepare('SELECT id, slug FROM event WHERE slug = ?')
    .bind(slugv)
    .first<{ id: string; slug: string }>();
  if (!ev) return { ok: false, code: 'not-found' };
  const demoSlugs = new Set(buildSeed().event.map((r) => String(r['slug'])));
  if (demoSlugs.has(ev.slug)) return { ok: false, code: 'demo-event' };

  // Collect this tree's R2 keys before the rows that name them go.
  const keys = await db
    .prepare(
      `SELECT r2_key FROM file
        WHERE (owner_kind = 'submission' AND owner_id IN (SELECT id FROM submission WHERE event_id = ?1))
           OR (owner_kind = 'event' AND owner_id = ?1)`
    )
    .bind(ev.id)
    .all<{ r2_key: string }>();

  for (const part of chunk(eventTreeDeletes(db, ev.id), MAX_STATEMENTS)) await db.batch(part);
  for (const k of keys.results ?? []) await bucket.delete(k.r2_key);
  return { ok: true, dropped: ev.id, files: (keys.results ?? []).length };
}

/** Drop listed people (gedanken contacts) after their event is gone. Each is
 *  cleaned of its leaves, then deleted; one still referenced elsewhere — a
 *  speaking record at another event — is reported, never force-torn. */
export async function dropPeople(
  db: D1Database,
  ids: string[]
): Promise<Record<string, 'dropped' | 'not-found' | 'still-referenced' | 'fixture'>> {
  const fixture = new Set(buildSeed().person.map((r) => String(r['id'])));
  const out: Record<string, 'dropped' | 'not-found' | 'still-referenced' | 'fixture'> = {};
  for (const id of ids) {
    if (fixture.has(id)) {
      out[id] = 'fixture'; // reseed owns fixture people; never drop them here
      continue;
    }
    const exists = await db.prepare('SELECT id FROM person WHERE id = ?').bind(id).first();
    if (!exists) {
      out[id] = 'not-found';
      continue;
    }
    try {
      await db.batch([
        db.prepare("DELETE FROM crm_note WHERE author_id = ?1 OR (owner_kind = 'person' AND owner_id = ?1) OR (owner_kind = 'card' AND owner_id IN (SELECT id FROM crm_card WHERE person_id = ?1))").bind(id),
        db.prepare('DELETE FROM crm_card_event WHERE card_id IN (SELECT id FROM crm_card WHERE person_id = ?1)').bind(id),
        db.prepare('DELETE FROM crm_card WHERE person_id = ?1 OR created_by = ?1').bind(id),
        db.prepare('DELETE FROM crm_tag WHERE person_id = ?1').bind(id),
        db.prepare('DELETE FROM crm_segment WHERE created_by = ?1').bind(id),
        db.prepare('DELETE FROM roster_entry WHERE person_id = ?1').bind(id),
        db.prepare('DELETE FROM pending_action WHERE person_id = ?1').bind(id),
        db.prepare('DELETE FROM agent_audit WHERE person_id = ?1').bind(id),
        db.prepare('DELETE FROM reply_ticket WHERE speaker_person_id = ?1').bind(id),
        db.prepare('DELETE FROM connection WHERE owner_person_id = ?1 OR other_person_id = ?1').bind(id),
        db.prepare('DELETE FROM friend_request WHERE requester_id = ?1 OR recipient_id = ?1').bind(id),
        db.prepare('DELETE FROM speaker_follow WHERE follower_person_id = ?1 OR speaker_person_id = ?1').bind(id),
        db.prepare('DELETE FROM speaker_helper WHERE speaker_person_id = ?1 OR helper_person_id = ?1').bind(id),
        db.prepare("DELETE FROM file WHERE owner_kind = 'person' AND owner_id = ?1").bind(id),
        db.prepare('DELETE FROM star WHERE my_schedule_id IN (SELECT id FROM my_schedule WHERE person_id = ?1)').bind(id),
        db.prepare('DELETE FROM my_schedule WHERE person_id = ?1').bind(id),
        db.prepare('DELETE FROM event_role WHERE person_id = ?1').bind(id),
        db.prepare('DELETE FROM person WHERE id = ?1').bind(id),
      ]);
      out[id] = 'dropped';
    } catch {
      out[id] = 'still-referenced';
    }
  }
  return out;
}
