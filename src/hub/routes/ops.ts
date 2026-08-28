import type { FastifyPluginAsync, FastifyPluginOptions, FastifyRequest } from 'fastify'
import { claimCard, createCard, moveCard, updateCard } from '../cards.js'
import { latestOrgSeq } from '../events.js'
import { drainInbox, sendMail } from '../mail.js'
import { heartbeat, listAgents, registerAgent } from '../presence.js'
import { ValidationError } from '../errors.js'
import type { HubSqlPool } from '../sql.js'

export interface HubOpsRouteOptions extends FastifyPluginOptions {
  sql: HubSqlPool
}

/** Every op a daemon can issue. Anything not listed here is a 400, not a 404. */
const OPS = new Set([
  'card.create', 'card.update', 'card.move', 'card.claim',
  'mail.send', 'agent.register', 'agent.heartbeat',
])

/**
 * The ops endpoint and the org-scoped reads. This plugin carries no error
 * handler of its own — an uncaught throw here (a `HubError` from the domain
 * modules, or anything else) bubbles to the single `setErrorHandler`
 * registered on the root server in server.ts, so there is exactly one place
 * that decides what a client is allowed to see.
 */
export const hubOpsPlugin: FastifyPluginAsync<HubOpsRouteOptions> = async (app, options) => {
  const { sql } = options

  app.post('/orgs/:orgId/ops', async (request: FastifyRequest, reply) => {
    const orgId = requireOrg(request)
    const body = (request.body ?? {}) as Record<string, any>
    const op = typeof body.op === 'string' ? body.op : ''
    if (!OPS.has(op)) throw new ValidationError(`unknown op: ${op || '(missing)'}`)

    const payload = (body.payload ?? {}) as Record<string, any>
    const idempotencyKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : null
    const actorDeviceId = request.hubDevice?.id ?? null
    const common = { orgId, actorDeviceId, idempotencyKey }

    const result = await runOp(op, payload, common, sql)
    return reply.send({ result, seq: await latestOrgSeq(sql, orgId) })
  })

  app.get('/orgs/:orgId/cards', async (request, reply) => {
    const orgId = requireOrg(request)
    const cards = await sql.query('SELECT * FROM cards WHERE org_id = $1 ORDER BY number', [orgId])
    return reply.send({ cards: cards.rows.map((row: any) => ({ ...row, column: row.column_name })) })
  })

  app.get('/orgs/:orgId/agents', async (request, reply) => {
    return reply.send({ agents: await listAgents(sql, requireOrg(request)) })
  })

  app.get('/orgs/:orgId/mail/inbox', async (request, reply) => {
    const orgId = requireOrg(request)
    const agent = (request.query as any)?.agent
    if (typeof agent !== 'string' || !agent) throw new ValidationError('agent query parameter is required')
    return reply.send({ messages: await drainInbox(sql, orgId, agent) })
  })
}

async function runOp(
  op: string, payload: Record<string, any>,
  common: { orgId: string; actorDeviceId: string | null; idempotencyKey: string | null },
  sql: HubSqlPool,
): Promise<unknown> {
  switch (op) {
    case 'card.create':
      return createCard(sql, {
        ...common, boardId: payload.board_id, title: payload.title,
        description: payload.description, paths: payload.paths, ownerAgent: payload.owner_agent ?? null,
      })
    case 'card.update':
      return updateCard(sql, {
        ...common, cardId: payload.card_id, expectedVersion: payload.expected_version,
        title: payload.title, description: payload.description, paths: payload.paths,
      })
    case 'card.move':
      return moveCard(sql, {
        ...common, cardId: payload.card_id, expectedVersion: payload.expected_version, column: payload.column,
      })
    case 'card.claim':
      return claimCard(sql, { ...common, cardId: payload.card_id, agent: payload.agent })
    case 'mail.send':
      return sendMail(sql, {
        ...common, boardId: payload.board_id, fromAgent: payload.from_agent,
        toAgent: payload.to_agent ?? null, toHuman: payload.to_human ?? false,
        subject: payload.subject, body: payload.body, cardId: payload.card_id ?? null,
        kind: payload.kind, replyTo: payload.reply_to ?? null,
      })
    case 'agent.register':
      return registerAgent(sql, {
        orgId: common.orgId, boardId: payload.board_id, name: payload.name, deviceId: common.actorDeviceId,
      })
    case 'agent.heartbeat':
      return heartbeat(sql, {
        orgId: common.orgId, agentId: payload.agent_id, state: payload.state,
        currentCardId: payload.current_card_id ?? null, activity: payload.activity ?? null,
      })
    default:
      throw new ValidationError(`unknown op: ${op}`)
  }
}

function requireOrg(request: FastifyRequest): string {
  const orgId = request.hubOrgId
  if (!orgId) throw new ValidationError('org scope was not resolved')
  return orgId
}
