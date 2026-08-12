// R-2: reseed is a full deterministic rebuild. DELETE everything, re-insert
// the world from seed.ts. Inserts only — trigger-safe by construction.
import { buildSeed, assertDistribution, type SeedData, type Row } from '../../seed/seed';

// Reverse-FK wipe order; forward order for inserts.
const INSERT_ORDER: (keyof SeedData)[] = [
  'event', 'person', 'track', 'room', 'submission', 'participation', 'review',
  'event_role', 'task', 'message', 'my_schedule', 'star', 'connection',
  'question', 'answer',
];
const WIPE_EXTRA = ['embedding', 'matrix_cache', 'neighbor', 'theme_cache', 'revision', 'file', 'ai_budget', '_guard'];

const MAX_PARAMS = 90;
const MAX_STATEMENTS = 40;

function insertStatements(db: D1Database, table: string, rows: Row[]): D1PreparedStatement[] {
  if (rows.length === 0) return [];
  const first = rows[0];
  if (!first) return [];
  const cols = Object.keys(first);
  const perChunk = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const placeholders = chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${placeholders}`;
    const bindings = chunk.flatMap((r) => cols.map((c) => r[c] ?? null));
    out.push(db.prepare(sql).bind(...bindings));
  }
  return out;
}

export async function reseed(db: D1Database): Promise<{ facts: string; inserted: Record<string, number>; ms: number }> {
  const t0 = Date.now();
  const data = buildSeed();
  const facts = assertDistribution(data); // refuse to wipe if the new world is wrong

  const wipe = [...INSERT_ORDER].reverse().map((t) => db.prepare(`DELETE FROM ${t}`));
  for (const t of WIPE_EXTRA) wipe.push(db.prepare(`DELETE FROM ${t}`));
  await db.batch(wipe);

  const inserted: Record<string, number> = {};
  let pending: D1PreparedStatement[] = [];
  for (const table of INSERT_ORDER) {
    const rows = data[table];
    inserted[table] = rows.length;
    for (const stmt of insertStatements(db, table, rows)) {
      pending.push(stmt);
      if (pending.length >= MAX_STATEMENTS) {
        await db.batch(pending);
        pending = [];
      }
    }
  }
  if (pending.length) await db.batch(pending);
  return { facts, inserted, ms: Date.now() - t0 };
}
