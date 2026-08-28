import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { ForbiddenError, NotFoundError } from './errors.js'
import type { HubSql } from './sql.js'
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
 */
export async function mintDeviceToken(
  sql: HubSql, input: MintDeviceInput,
): Promise<{ device: HubDevice; token: string }> {
  const name = boundedString(input.name, 'name', 120)
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`

  const inserted = await sql.query<HubDevice>(
    `INSERT INTO devices (id, org_id, membership_id, name, token_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, org_id, membership_id, name, last_seen_at, revoked_at`,
    [`dev_${randomUUID()}`, input.orgId, input.membershipId ?? null, name, hashToken(token)],
  )
  return { device: inserted.rows[0], token }
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
