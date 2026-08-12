// Temporary CP0 probe (08 §7.1): prove, on real D1, that
//   (a) a guard statement failing mid-batch aborts the WHOLE batch,
//   (b) a trigger RAISE(ABORT) does the same,
//   (c) meta.changes is reported per statement.
// This file is deleted once the answers are recorded in the build log.

export async function cp0GuardProbe(db: D1Database): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  await db.exec('DROP TABLE IF EXISTS _probe_g');
  await db.exec('DROP TABLE IF EXISTS _probe_t');
  await db.exec('CREATE TABLE _probe_g (ok INTEGER NOT NULL CHECK (ok = 1))');
  await db.exec('CREATE TABLE _probe_t (n INTEGER)');

  // (a1) guard passes → batch lands whole
  const pass = await db.batch([
    db.prepare('INSERT INTO _probe_t VALUES (1)'),
    db.prepare('INSERT INTO _probe_g (ok) SELECT 0 WHERE 1 = 0'), // no rows: silent
    db.prepare('INSERT INTO _probe_t VALUES (2)'),
    db.prepare("UPDATE _probe_t SET n = n + 10 WHERE n >= 1"),
  ]);
  out.pass_meta_changes = pass.map((r) => r.meta.changes);

  // (a2) guard fires → CHECK violation → whole batch must roll back
  let aborted = false;
  try {
    await db.batch([
      db.prepare('INSERT INTO _probe_t VALUES (3)'),
      db.prepare('INSERT INTO _probe_g (ok) SELECT 0 WHERE 1 = 1'), // CHECK fails
      db.prepare('INSERT INTO _probe_t VALUES (4)'),
    ]);
  } catch (e) {
    aborted = true;
    out.guard_error = String(e).slice(0, 160);
  }
  const after = await db.prepare('SELECT n FROM _probe_t ORDER BY n').all();
  out.guard_aborted = aborted;
  out.rows_after_guard = after.results.map((r) => (r as { n: number }).n); // want [11,12] only

  // (b) trigger RAISE(ABORT) inside a batch
  await db.exec(
    "CREATE TRIGGER _probe_trg BEFORE UPDATE OF n ON _probe_t WHEN new.n = 99 BEGIN SELECT RAISE(ABORT, 'illegal transition'); END"
  );
  let trgAborted = false;
  try {
    await db.batch([
      db.prepare('INSERT INTO _probe_t VALUES (5)'),
      db.prepare('UPDATE _probe_t SET n = 99 WHERE n = 11'),
    ]);
  } catch (e) {
    trgAborted = true;
    out.trigger_error = String(e).slice(0, 160);
  }
  const after2 = await db.prepare('SELECT n FROM _probe_t ORDER BY n').all();
  out.trigger_aborted = trgAborted;
  out.rows_after_trigger = after2.results.map((r) => (r as { n: number }).n); // want [11,12] still

  await db.exec('DROP TABLE _probe_g');
  await db.exec('DROP TABLE _probe_t');

  out.verdict =
    aborted &&
    trgAborted &&
    JSON.stringify(out.rows_after_guard) === '[11,12]' &&
    JSON.stringify(out.rows_after_trigger) === '[11,12]'
      ? 'GUARDS HOLD — build on them'
      : 'GUARDS DO NOT HOLD — two-phase shape needed';
  return out;
}
