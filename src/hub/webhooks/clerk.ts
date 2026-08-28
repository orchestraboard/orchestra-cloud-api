import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { verifyWebhook } from '@clerk/backend/webhooks'
import type {
  OrganizationJSON,
  OrganizationMembershipJSON,
  UserJSON,
  UserDeletedJSON,
  DeletedObjectJSON,
  WebhookEvent,
} from '@clerk/backend'
import { ensureDefaultProject } from '../projects.js'
import { withTransaction, type HubSql, type HubSqlPool } from '../sql.js'

export interface HubClerkWebhookEnv {
  clerkWebhookSigningSecret?: string
}

export interface HubClerkWebhookPluginOptions {
  sql: HubSqlPool
  env: HubClerkWebhookEnv
}

/**
 * Mirrors Clerk's identity model (users, orgs, org memberships) into Postgres so
 * every other org-scoped query in the hub never has to call Clerk on the
 * request path — see src/hub/clerk.ts's `resolveOrgForClerk`, which reads only
 * these mirror tables.
 *
 * Mounted OUTSIDE `/api/v1/hub/` in server.ts on purpose: Plan 1's bearer-token
 * `onRequest` auth hook only applies to that prefix, so this route is
 * unauthenticated by that hook by design — it carries its own Svix signature
 * (verified below) instead of a bearer token. Never accept a payload here
 * whose signature didn't verify.
 */
export const hubClerkWebhookPlugin: FastifyPluginAsync<HubClerkWebhookPluginOptions> = async (fastify, opts) => {
  const { sql, env } = opts

  // Signature verification needs the *exact* bytes Clerk sent — a re-serialized
  // body (different key order, whitespace, unicode escaping) produces a
  // different signature and would fail against real Clerk traffic even though
  // it might happen to pass a test built the same way. Fastify's default JSON
  // parser destroys those bytes by parsing into an object, so this registers a
  // parser that keeps the raw buffer instead. Content-type parsers in Fastify
  // are scoped to the encapsulation context they're registered in (this
  // plugin isn't wrapped with fastify-plugin), so this shadows the default
  // JSON parser only for routes declared inside this plugin — hubOpsPlugin and
  // hubSyncPlugin's normal JSON bodies are untouched.
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  fastify.post('/webhooks/clerk', async (request, reply) => {
    const secret = env.clerkWebhookSigningSecret
    if (!secret) {
      // Never fall through to "accept unsigned" just because ops forgot to
      // configure the secret. 5xx (not 4xx) so Clerk keeps retrying until the
      // secret is set, instead of Clerk giving up on a permanent-looking 400.
      request.log.error('clerk webhook received but CLERK_WEBHOOK_SIGNING_SECRET is not configured')
      return reply.code(500).send({ error: 'webhook not configured', code: 'internal_error' })
    }

    // `verifyWebhook` (Svix's own `standardwebhooks` verifier under the hood)
    // takes a Fetch API Request, not a Fastify one — rebuild one from the raw
    // bytes and headers Fastify handed us above. The URL/host here are never
    // inspected by the verifier; only the body and the three svix-* headers
    // matter to it.
    const fetchRequest = new Request(`https://hub.internal${request.url}`, {
      method: 'POST',
      headers: toFetchHeaders(request.headers),
      // `new Uint8Array(buffer)` (not a bare Node Buffer) so this satisfies the
      // Fetch API's BodyInit type; it does not touch the bytes.
      body: new Uint8Array(request.body as Buffer),
    })

    let event: WebhookEvent
    try {
      event = await verifyWebhook(fetchRequest, { signingSecret: secret })
    } catch {
      // Deliberately do not distinguish "bad signature" from "bad/missing
      // headers" from "expired timestamp" in the response body — none of that
      // is actionable to whoever (or whatever) sent this, and the detail is
      // still in the server log via verifyWebhook's own thrown message.
      return reply.code(400).send({ error: 'invalid webhook signature', code: 'validation_failed' })
    }

    await applyClerkEvent(sql, event, request)
    return reply.code(200).send({ ok: true })
  })
}

function toFetchHeaders(headers: FastifyRequest['headers']): Headers {
  const result = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) result.append(key, entry)
    } else if (typeof value === 'string') {
      result.set(key, value)
    }
  }
  return result
}

/**
 * Applies one verified Clerk event to the mirror tables. Every branch is
 * written to be naturally idempotent (upsert on the Clerk id / delete-if-
 * present) rather than tracked by a separate "already processed this Svix
 * message id" ledger — there is no migration budget in this task to add one,
 * and every event this handles is either an upsert keyed on a UNIQUE Clerk id
 * column (`users.clerk_user_id`, `orgs.clerk_org_id`, the
 * `memberships(org_id, user_id)` unique pair) or a delete-if-present, both of
 * which replay to the same end state. Clerk retries any non-2xx response, so
 * replays are not hypothetical.
 *
 * Runs in one transaction so a partial mirror update (e.g. the membership
 * upsert succeeding but a subsequent step failing) can never be observed.
 */
async function applyClerkEvent(sql: HubSqlPool, event: WebhookEvent, request: FastifyRequest): Promise<void> {
  await withTransaction(sql, async (tx) => {
    switch (event.type) {
      case 'user.created':
      case 'user.updated':
        await upsertUser(tx, event.data as UserJSON)
        return
      case 'user.deleted':
        await deleteUser(tx, event.data as UserDeletedJSON)
        return
      case 'organization.created':
      case 'organization.updated':
        await upsertOrg(tx, event.data as OrganizationJSON, event.type === 'organization.created', request)
        return
      case 'organization.deleted':
        await deleteOrg(tx, event.data as DeletedObjectJSON)
        return
      case 'organizationMembership.created':
        await upsertMembership(tx, event.data as OrganizationMembershipJSON, request)
        return
      case 'organizationMembership.updated':
        await upsertMembership(tx, event.data as OrganizationMembershipJSON, request)
        return
      case 'organizationMembership.deleted':
        await deleteMembership(tx, event.data as OrganizationMembershipJSON)
        return
      default:
        // An event type we don't mirror (e.g. session.*, role.*). Acknowledged
        // as a no-op — see the plugin doc comment: erroring here would make
        // Clerk retry an event this hub will never handle, forever.
        request.log.info({ eventType: (event as { type: string }).type }, 'clerk webhook: unhandled event type, ack only')
        return
    }
  })
}

async function upsertUser(tx: HubSql, data: UserJSON): Promise<void> {
  await tx.query(
    `INSERT INTO users (id, clerk_user_id, email, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (clerk_user_id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name`,
    [`user_${randomUUID()}`, data.id, primaryEmail(data), displayName(data)],
  )
}

async function deleteUser(tx: HubSql, data: UserDeletedJSON): Promise<void> {
  if (!data.id) return
  // Cascades through memberships (user_id) to devices (membership_id) — a
  // deleted Clerk user loses every daemon token across every org they
  // belonged to, not just the org this event happens to be about.
  await tx.query('DELETE FROM users WHERE clerk_user_id = $1', [data.id])
}

/**
 * On `organization.created`, this also gives the org a default project and board.
 *
 * Without it a paying customer lands on an empty org with no board, and every write op
 * (which all require an existing `board_id` — see src/hub/projects.ts) is unsatisfiable:
 * there was no way at all to create one. `RETURNING id` on the upsert covers the replay
 * case too — Clerk retries any non-2xx, so `organization.created` can arrive more than
 * once — because `ensureDefaultProject` no-ops when the org already has a project, and
 * runs inside this handler's transaction on the org row this statement just wrote.
 */
async function upsertOrg(
  tx: HubSql, data: OrganizationJSON, created: boolean, request: FastifyRequest,
): Promise<void> {
  const org = await tx.query<{ id: string }>(
    `INSERT INTO orgs (id, clerk_org_id, name, slug)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (clerk_org_id) DO UPDATE SET name = excluded.name, slug = excluded.slug
     RETURNING id`,
    [`org_${randomUUID()}`, data.id, data.name, data.slug],
  )
  const orgId = org.rows[0]?.id
  if (!created || !orgId) return

  const seeded = await ensureDefaultProject(tx, orgId)
  if (seeded) {
    request.log.info(
      { orgId, projectId: seeded.project.id, boardId: seeded.board.id },
      'clerk webhook: seeded the default project and board for a new org',
    )
  }
}

async function deleteOrg(tx: HubSql, data: DeletedObjectJSON): Promise<void> {
  if (!data.id) return
  // Cascades through projects/boards/memberships/devices/subscriptions.
  await tx.query('DELETE FROM orgs WHERE clerk_org_id = $1', [data.id])
}

/** Clerk's default role keys are `org:admin` / `org:member`; custom role keys are also possible.
 * Unrecognized keys degrade to the least-privileged `member` rather than failing the whole
 * webhook — a custom role Clerk supports but this mirror doesn't model yet must not turn into a
 * dropped/retried-forever event. */
function mapClerkRole(raw: string): 'owner' | 'admin' | 'member' {
  const bare = raw.startsWith('org:') ? raw.slice('org:'.length) : raw
  return bare === 'owner' || bare === 'admin' ? bare : 'member'
}

function primaryEmail(data: UserJSON): string {
  const primary = data.email_addresses.find((e) => e.id === data.primary_email_address_id)
  return primary?.email_address ?? data.email_addresses[0]?.email_address ?? `${data.id}@clerk.invalid`
}

function displayName(data: UserJSON): string | null {
  const parts = [data.first_name, data.last_name].filter((p): p is string => Boolean(p && p.trim()))
  return parts.length > 0 ? parts.join(' ') : null
}

/**
 * Handles both `organizationMembership.created` and `.updated` — both are the
 * same upsert keyed on the (org_id, user_id) unique pair. If the org or user
 * hasn't been mirrored yet (Clerk does not guarantee delivery order across
 * event types — an org's `organizationMembership.created` can arrive before
 * its `organization.created`), this throws rather than silently dropping the
 * event; a non-2xx response makes Clerk retry, and by the retry the
 * dependency will typically have landed via its own webhook.
 */
async function upsertMembership(tx: HubSql, data: OrganizationMembershipJSON, request: FastifyRequest): Promise<void> {
  const org = await tx.query<{ id: string; seat_cap: number }>(
    'SELECT id, seat_cap FROM orgs WHERE clerk_org_id = $1', [data.organization.id],
  )
  const user = await tx.query<{ id: string }>(
    'SELECT id FROM users WHERE clerk_user_id = $1', [data.public_user_data.user_id],
  )
  if (!org.rows[0] || !user.rows[0]) {
    throw new Error('clerk webhook: organizationMembership references an org or user not yet mirrored')
  }

  await tx.query(
    `INSERT INTO memberships (id, org_id, user_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role`,
    [`mem_${randomUUID()}`, org.rows[0].id, user.rows[0].id, mapClerkRole(data.role)],
  )

  // Entitlement enforcement (rejecting/gating over-cap membership) is Task 6's
  // job — see the brief. Task 4's job is only to make sure the data it needs
  // (an accurate membership count vs. `orgs.seat_cap`) is captured and that
  // this webhook never flaps/rejects on it. This count is read fresh, not
  // stored, so Task 6 can compute over-cap status itself without a schema
  // change here.
  const count = await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM memberships WHERE org_id = $1', [org.rows[0].id])
  const memberCount = Number(count.rows[0]?.n ?? 0)
  if (memberCount > org.rows[0].seat_cap) {
    request.log.warn(
      { orgId: org.rows[0].id, seatCap: org.rows[0].seat_cap, memberCount },
      'clerk webhook: org membership created over seat cap (accepted; Task 6 enforces entitlement)',
    )
  }
}

/**
 * A no-op (not an error) when the org or user is already gone — an
 * `organization.deleted`/`user.deleted` event that arrived first already
 * cascaded this membership (and its devices) away. Deleting the row here
 * cascades to `devices` (via `devices.membership_id ON DELETE CASCADE`),
 * which is the actual revocation: once the row is gone, `verifyDeviceToken`
 * (src/hub/devices.ts) finds no matching token and refuses it. A member
 * removed from an org therefore loses their daemon's access on this same
 * webhook, not on next token expiry.
 */
async function deleteMembership(tx: HubSql, data: OrganizationMembershipJSON): Promise<void> {
  const org = await tx.query<{ id: string }>('SELECT id FROM orgs WHERE clerk_org_id = $1', [data.organization.id])
  if (!org.rows[0]) return
  const user = await tx.query<{ id: string }>('SELECT id FROM users WHERE clerk_user_id = $1', [data.public_user_data.user_id])
  if (!user.rows[0]) return

  await tx.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [org.rows[0].id, user.rows[0].id])
}
