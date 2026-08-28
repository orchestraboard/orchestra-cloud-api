import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { assertSeatAvailable } from './entitlements.js'
import { ForbiddenError, NotFoundError } from './errors.js'
import { withTransaction, type HubSql, type HubSqlPool } from './sql.js'
import { boundedString } from './validate.js'

/** Exported so server.ts can discriminate device vs. Clerk tokens by shape alone, with no lookup. */
export const DEVICE_TOKEN_PREFIX = 'orchestra_device_v1.'
const TOKEN_PREFIX = DEVICE_TOKEN_PREFIX

export interface HubDevice {
  id: string
  org_id: string
  membership_id: string | null
  name: string
  last_seen_at: string | null
  revoked_at: string | null
}

export interface MintDeviceInput {
  orgId: string
  membershipId?: string | null
  name: string
}

/**
 * Returns the plaintext token exactly once — only its SHA-256 is stored, so a
 * database read cannot impersonate a daemon.
 *
 * The seat cap is enforced HERE, not on membership creation — see
 * `assertSeatAvailable`'s doc comment (entitlements.ts) for why a member Clerk has
 * already admitted is never retroactively disabled. When `input.membershipId` is
 * given, only the first N members (by join order) may mint a device token; everyone
 * else can still sign in and view the board, just not connect a daemon. Callers with
 * no membership behind the token (`membershipId` omitted — every pre-existing
 * caller/test) are unaffected.
 *
 * Locks the org row for the duration of this transaction, the same pattern (and for
 * the same reason) as `registerAgent`'s concurrent-agent-capacity check in
 * presence.ts: without it, two concurrent mints for two different memberships that
 * would each individually rank within the seat cap could both read "under cap" and
 * both commit, handing out one more connected daemon than the org paid for.
 */
export async function mintDeviceToken(
  sql: HubSqlPool, input: MintDeviceInput,
): Promise<{ device: HubDevice; token: string }> {
  const name = boundedString(input.name, 'name', 120)
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`

  return withTransaction(sql, async (tx) => {
    await tx.query('SELECT id FROM orgs WHERE id = $1 FOR UPDATE', [input.orgId])

    if (input.membershipId) {
      await assertSeatAvailable(tx, input.orgId, input.membershipId)
    }

    const inserted = await tx.query<HubDevice>(
      `INSERT INTO devices (id, org_id, membership_id, name, token_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, org_id, membership_id, name, last_seen_at, revoked_at`,
      [`dev_${randomUUID()}`, input.orgId, input.membershipId ?? null, name, hashToken(token)],
    )
    return { device: inserted.rows[0], token }
  })
}

/**
 * The `WHERE token_hash = $1` lookup already requires an exact hash match to
 * return a row, so `device.token_hash` can never differ from `hashToken(token)`
 * once we get here — `constantTimeEquals` below is a no-op re-check, not a
 * meaningful timing defense (the hash itself, not this comparison, is what
 * makes guessing infeasible). Kept anyway as cheap defense in depth in case the
 * query above is ever changed to a broader scan.
 */
export async function verifyDeviceToken(sql: HubSql, token: string): Promise<HubDevice> {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
    throw new ForbiddenError('device token is not valid')
  }
  const result = await sql.query<HubDevice & { token_hash: string }>(
    `SELECT id, org_id, membership_id, name, last_seen_at, revoked_at, token_hash
     FROM devices WHERE token_hash = $1`,
    [hashToken(token)],
  )
  const device = result.rows[0]
  if (!device || !constantTimeEquals(device.token_hash, hashToken(token))) {
    throw new ForbiddenError('device token is not valid')
  }
  if (device.revoked_at) throw new ForbiddenError('device token has been revoked')

  await sql.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [device.id])
  const { token_hash, ...rest } = device
  return rest
}

export async function revokeDevice(sql: HubSql, orgId: string, deviceId: string): Promise<void> {
  const result = await sql.query(
    'UPDATE devices SET revoked_at = now() WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING id',
    [orgId, deviceId],
  )
  if (result.rows.length === 0) throw new NotFoundError('device not found in this org')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
