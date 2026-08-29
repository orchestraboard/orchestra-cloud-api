/**
 * The single storage seam for the hub. Production passes a `pg.Pool`; tests pass a
 * PGlite adapter. Nothing under src/hub/ may import a concrete driver.
 */
export interface HubSql {
  query<R = any>(text: string, params?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number }>
}

/** A connection that can be exclusively held for the duration of a transaction. */
export interface HubSqlPool extends HubSql {
  connect?(): Promise<HubSqlConnection>
}

export interface HubSqlConnection extends HubSql {
  release(): void
}

/**
 * Runs `fn` inside one transaction.
 *
 * With a pool that can hand out a dedicated connection (real Postgres, via
 * `createPgPool`), this is a real transaction: BEGIN/COMMIT and everything between
 * them run on one connection that nothing else can touch, so concurrent
 * transactions are isolated by the database.
 *
 * The `conn = null` fallback is NOT that. It issues BEGIN/COMMIT/ROLLBACK against
 * a shared handle, which for the PGlite test adapter is a single connection shared
 * by every caller. PGlite serialises each individual statement, but it does not
 * scope a transaction to a caller: two overlapping `withTransaction` calls
 * interleave their statements on one session, so the second BEGIN joins the first
 * transaction and the first COMMIT commits both. A rolled-back transaction's writes
 * can survive because a concurrent COMMIT got there before the ROLLBACK.
 *
 * The practical consequence, for whoever reads this next: the test harness can
 * PASS a concurrency test that should fail. Isolation and rollback-under-contention
 * are not observable through the fallback — a test that appears to prove them is
 * proving nothing. Assert those against real Postgres, or not at all.
 */
export async function withTransaction<T>(sql: HubSqlPool, fn: (tx: HubSql) => Promise<T>): Promise<T> {
  const conn = sql.connect ? await sql.connect() : null
  const handle: HubSql = conn ?? sql
  await handle.query('BEGIN')
  try {
    const result = await fn(handle)
    await handle.query('COMMIT')
    return result
  } catch (error) {
    await handle.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    conn?.release()
  }
}
