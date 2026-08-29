import pg from 'pg'
import type { HubSqlConnection, HubSqlPool } from './sql.js'

/**
 * Production storage. Supabase's session pooler is the right endpoint here — the
 * hub is a long-lived server holding transactions, not a serverless function.
 */
export function createPgPool(connectionString: string): HubSqlPool & { end(): Promise<void> } {
  const pool = new pg.Pool({ connectionString, max: 10 })

  return {
    query: async (text, params) => {
      const result = await pool.query(text, params ? [...params] : undefined)
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }
    },
    connect: async (): Promise<HubSqlConnection> => {
      const client = await pool.connect()
      // pg-pool only guards double-release; it does nothing to stop a query on a
      // client that has already gone back to the pool (and may now be serving a
      // different caller), so this connection tracks its own released state.
      let released = false
      return {
        query: async (text, params) => {
          if (released) throw new Error('query called on a HubSqlConnection that has already been released')
          const result = await client.query(text, params ? [...params] : undefined)
          return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }
        },
        release: () => {
          released = true
          client.release()
        },
      }
    },
    end: () => pool.end(),
  }
}
