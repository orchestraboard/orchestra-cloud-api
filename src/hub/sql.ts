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
 * Runs `fn` inside one transaction. When the pool can hand out a dedicated
 * connection we use it (real Postgres); PGlite is single-connection and serialises
 * on its own, so the fallback issues the same statements against the shared handle.
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
