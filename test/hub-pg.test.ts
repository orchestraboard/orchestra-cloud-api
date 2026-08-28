import { describe, it, expect, vi } from 'vitest'

// createPgPool must never open a real socket in tests — stand in for the pg
// driver with a fake Pool whose shape mirrors what pg.Pool actually returns.
function makeFakeClient(rowsByQuery: Record<string, { rows: any[]; rowCount: number | null }>) {
  const calls: string[] = []
  let released = false
  return {
    released: () => released,
    calls,
    client: {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        return rowsByQuery[text] ?? { rows: [], rowCount: null }
      }),
      release: vi.fn(() => { released = true }),
    },
  }
}

vi.mock('pg', () => {
  return {
    default: {
      Pool: vi.fn().mockImplementation(function (this: any) {
        this.query = vi.fn(async (_text: string, _params?: unknown[]) => ({ rows: [{ ok: 1 }], rowCount: null }))
        this.connect = vi.fn()
        this.end = vi.fn(async () => {})
      }),
    },
  }
})

describe('createPgPool', () => {
  it('normalizes a null rowCount (e.g. DDL statements) to the row length', async () => {
    const { createPgPool } = await import('../src/hub/pg.js')
    const pool = createPgPool('postgres://example/hub')
    const result = await pool.query('CREATE TABLE t (id text)')
    expect(result.rowCount).toBe(1)
    expect(result.rows).toEqual([{ ok: 1 }])
  })

  it('rejects a query on a connection after release()', async () => {
    const pgMod: any = await import('pg')
    const fake = makeFakeClient({})
    const PoolCtor = pgMod.default.Pool as any
    PoolCtor.mockImplementation(function (this: any) {
      this.connect = vi.fn(async () => fake.client)
      this.query = vi.fn()
      this.end = vi.fn(async () => {})
    })

    const { createPgPool } = await import('../src/hub/pg.js')
    const pool = createPgPool('postgres://example/hub')
    const conn = await pool.connect!()
    conn.release()
    expect(fake.released()).toBe(true)
    await expect(conn.query('SELECT 1')).rejects.toThrow(/already been released/)
  })
})
