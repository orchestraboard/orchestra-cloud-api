import type { FastifyInstance } from 'fastify'
import { buildHubServer } from '../../src/hub/server.js'
import { mintDeviceToken } from '../../src/hub/devices.js'
import { hubTestSql, seedOrg, seedBoard } from './hub-sql.js'
import type { HubSqlPool } from '../../src/hub/sql.js'
import type { HubBroadcaster } from '../../src/hub/broadcast.js'

export interface HubFixture {
  sql: HubSqlPool
  server: FastifyInstance
  orgId: string
  boardId: string
  token: string
  auth: (token?: string) => Record<string, string>
  /** The broadcaster wired into `server` — for asserting subscribe/unsubscribe behavior. */
  broadcast: HubBroadcaster
}

const servers: FastifyInstance[] = []

/** Every test gets its own migrated database, org, board, and device token. */
export async function hubFixture(): Promise<HubFixture> {
  const sql = (await hubTestSql()) as HubSqlPool
  await seedOrg(sql, 'org_a')
  await seedBoard(sql, 'org_a', 'board_1')
  const { token } = await mintDeviceToken(sql, { orgId: 'org_a', name: 'test-laptop' })

  const server = buildHubServer(sql)
  servers.push(server)
  await server.ready()

  return {
    sql, server, orgId: 'org_a', boardId: 'board_1', token,
    auth: (override?: string) => ({ authorization: `Bearer ${override ?? token}` }),
    broadcast: server.hubBroadcast,
  }
}

export async function closeHubServers(): Promise<void> {
  for (const server of servers.splice(0)) await server.close()
}
