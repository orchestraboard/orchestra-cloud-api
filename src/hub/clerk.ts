import { verifyToken } from '@clerk/backend'
import { ForbiddenError } from './errors.js'
import type { HubSql } from './sql.js'

/**
 * Fields `verifyClerkToken` reads off `HubEnv` (src/hub/env.ts) — declared
 * structurally here so this module doesn't import `HubEnv` itself (which would
 * pull `databaseUrl`/`port` requirements into every call site). A full `HubEnv`
 * satisfies this by assignment.
 */
export interface ClerkTokenEnv {
  clerkSecretKey?: string
}

export interface ClerkPrincipal {
  clerkUserId: string
  /** null when the token has no active organization selected. */
  clerkOrgId: string | null
}

export interface ResolvedClerkOrg {
  orgId: string
  membershipId: string
  userId: string
}

/**
 * One generic message for every way a Clerk token can fail to verify — no
 * secret key configured, malformed, bad signature, expired. Mirrors
 * `INVALID_TOKEN_BODY` in server.ts: the whole point of collapsing device-token
 * failures to one body (see devices.ts) is defeated if a second, differently
 * worded failure mode shows up for Clerk tokens instead.
 */
const CLERK_TOKEN_INVALID = 'clerk token is not valid'

/**
 * Verifies a Clerk session JWT's signature via `@clerk/backend`'s
 * `verifyToken`. Never returns unverified claims: a bad signature, expired
 * token, or missing secret key all throw the same `ForbiddenError`.
 *
 * The returned `clerkOrgId` is only ever used as a lookup key into the
 * `orgs`/`memberships` mirror (see `resolveOrgForClerk`) — it is never treated
 * as proof of membership by itself, since Clerk's JWT reflects the org the
 * user had *selected* at mint time, not whether they are still a member now.
 */
export async function verifyClerkToken(token: string, env: ClerkTokenEnv): Promise<ClerkPrincipal> {
  if (!env.clerkSecretKey) {
    throw new ForbiddenError(CLERK_TOKEN_INVALID)
  }

  // The `@clerk/backend` package root re-exports `verifyToken` as a throwing
  // convenience wrapper (`Promise<JwtPayload>`) around the lower-level
  // `{ data, errors }` result used internally — it rejects, it does not
  // resolve with an `.errors` array, so a bad signature/expired token is
  // caught here rather than checked for afterward.
  let payload: Awaited<ReturnType<typeof verifyToken>>
  try {
    payload = await verifyToken(token, { secretKey: env.clerkSecretKey })
  } catch {
    throw new ForbiddenError(CLERK_TOKEN_INVALID)
  }

  if (typeof payload?.sub !== 'string') {
    throw new ForbiddenError(CLERK_TOKEN_INVALID)
  }

  const raw = payload as Record<string, unknown>
  // Unversioned Clerk session tokens carry `org_id` directly; the newer `v: 2`
  // payload shape nests it under `o.id` instead (see @clerk/shared's
  // jwtv2.d.ts `VersionedJwtPayload`). Support both so verification doesn't
  // silently stop resolving org membership if/when Clerk rolls that out.
  const nestedOrg = raw.o as { id?: unknown } | undefined
  const clerkOrgId =
    (typeof raw.org_id === 'string' ? raw.org_id : undefined) ??
    (typeof nestedOrg?.id === 'string' ? nestedOrg.id : undefined) ??
    null

  return { clerkUserId: payload.sub, clerkOrgId }
}

const NOT_A_MEMBER = 'user is not a member of this org'

/**
 * Resolves a verified Clerk principal to the hub's own org/user/membership ids
 * by joining through the `users`/`orgs`/`memberships` mirror tables — never
 * from the JWT's claims alone. This is what makes revocation real: deleting a
 * `memberships` row here takes effect on the user's very next request, even
 * though their Clerk session JWT keeps validating (by signature and
 * expiry) until it naturally expires. If org membership were read off the
 * token instead, a removed member would keep hub access for the JWT's
 * remaining lifetime.
 */
export async function resolveOrgForClerk(sql: HubSql, principal: ClerkPrincipal): Promise<ResolvedClerkOrg> {
  if (!principal.clerkOrgId) {
    throw new ForbiddenError(NOT_A_MEMBER)
  }

  const result = await sql.query<{ org_id: string; membership_id: string; user_id: string }>(
    `SELECT o.id AS org_id, m.id AS membership_id, u.id AS user_id
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     JOIN orgs o ON o.id = m.org_id
     WHERE u.clerk_user_id = $1 AND o.clerk_org_id = $2`,
    [principal.clerkUserId, principal.clerkOrgId],
  )
  const row = result.rows[0]
  if (!row) {
    throw new ForbiddenError(NOT_A_MEMBER)
  }
  return { orgId: row.org_id, membershipId: row.membership_id, userId: row.user_id }
}
