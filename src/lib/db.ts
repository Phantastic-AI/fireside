// The write discipline: set-based statements, a guard that aborts the batch
// when a precondition went stale, and per-statement changes assertions.
// Guard semantics proven on live D1 at CP0 (see build log).

export class StaleStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleStateError';
  }
}

export class ChangesMismatchError extends Error {
  constructor(
    public statement: number,
    public expected: number,
    public actual: number
  ) {
    super(`statement ${statement} touched ${actual} rows, expected ${expected}`);
    this.name = 'ChangesMismatchError';
  }
}

/**
 * A guard statement: inserts one CHECK-violating row into _guard when the
 * precondition query yields a row, aborting the whole batch atomically.
 * `failWhen` is a SELECT that returns a row exactly when the batch must NOT run.
 */
export function guard(db: D1Database, failWhen: string, ...bindings: unknown[]): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO _guard (ok) SELECT 0 WHERE EXISTS (${failWhen})`)
    .bind(...bindings);
}

export type Expected = number | 'any' | { atLeast: number };

/**
 * Run a batch and assert per-statement meta.changes. `expect[i]` describes the
 * statement at the same index; guard statements should expect 0.
 * A guard firing surfaces as StaleStateError so the screen can say its own
 * sentence instead of a stack trace.
 */
export async function checkedBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
  expect: Expected[],
  staleMessage = 'the numbers moved while you were looking'
): Promise<D1Result[]> {
  if (statements.length !== expect.length) {
    throw new Error('expect list must match statements one for one');
  }
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (e) {
    if (String(e).includes('CHECK constraint failed: ok')) {
      throw new StaleStateError(staleMessage);
    }
    throw e;
  }
  results.forEach((r, i) => {
    const want = expect[i];
    if (want === 'any' || want === undefined) return;
    const changes = r.meta.changes ?? 0;
    if (typeof want === 'number') {
      if (changes !== want) throw new ChangesMismatchError(i, want, changes);
    } else if (changes < want.atLeast) {
      throw new ChangesMismatchError(i, want.atLeast, changes);
    }
  });
  return results;
}

/** Deterministic-friendly id: a prefix plus either a seed-stable suffix or a random one. */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let s = '';
  for (const b of bytes) s += 'abcdefghijklmnopqrstuvwxyz234567'[b % 32];
  return `${prefix}-${s}`;
}

export const now = (): number => Date.now();
