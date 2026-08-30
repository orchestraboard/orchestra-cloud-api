import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { ForbiddenError, NotFoundError } from './errors.js'
import { withTransaction, type HubSql, type HubSqlPool } from './sql.js'
import { boundedString } from './validate.js'

/** Exported so the auth hook can discriminate a CLI token by shape alone, with no lookup. */
export const CLI_TOKEN_PREFIX = 'orchestra_cli_v1.'

/** A login attempt is a live handshake, not a durable object — two minutes is generous. */
export const CLI_AUTH_TTL_SECONDS = 120

const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64url')

// Comparing hashes rather than secrets keeps both sides fixed-length, which is what makes a
// constant-time compare meaningful here.
const sameDigest = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface StartCliAuthInput { challenge: string; label: string }
export interface CliAuthRequest { id: string; expiresAt: string }

/**
 * Unauthenticated by design: this only reserves a row. Nothing is granted until a
 * signed-in human approves it, and nothing is issued without the verifier behind
 * `challenge`, which never leaves the machine that started the login.
 */
export async function startCliAuth(sql: HubSqlPool, input: StartCliAuthInput): Promise<CliAuthRequest> {
  const challenge = boundedString(input.challenge, 'challenge', 128)
  const label = boundedString(input.label, 'label', 120)
  const id = `cliauth_${randomUUID()}`
  const inserted = await sql.query<{ id: string; expires_at: string }>(
    `INSERT INTO cli_auth_requests (id, challenge, label, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4::int))
     RETURNING id, expires_at`,
    [id, challenge, label, CLI_AUTH_TTL_SECONDS],
  )
  return { id: inserted.rows[0].id, expiresAt: inserted.rows[0].expires_at }
}

export interface ApproveCliAuthInput { requestId: string; userId: string }

/**
 * Records who approved and returns the one-time code the browser hands back to the CLI.
 *
 * The approval is claimed with a conditional UPDATE (`approved_at IS NULL`), so a page
 * refresh or a double-click cannot mint a second code for the same request — the second
 * caller sees the same 403 as someone replaying a stranger's request id.
 */
export async function approveCliAuth(sql: HubSqlPool, input: ApproveCliAuthInput): Promise<{ code: string }> {
  const code = randomBytes(32).toString('base64url')
  const updated = await sql.query<{ id: string }>(
    `UPDATE cli_auth_requests
        SET approved_at = now(), user_id = $2, code_hash = $3
      WHERE id = $1 AND approved_at IS NULL AND consumed_at IS NULL AND expires_at > now()
      RETURNING id`,
    [input.requestId, input.userId, sha256(code)],
  )
  if (updated.rows.length === 0) {
    throw new ForbiddenError('this login request is unknown, already used, or has expired')
  }
  return { code }
}

export interface ExchangeCliAuthInput { requestId: string; code: string; verifier: string }
export interface CliTokenIssued { token: string; userId: string }

/**
 * Trades an approved code plus the original verifier for a CLI token.
 *
 * Unauthenticated on purpose: the credential IS the pair (code, verifier). A code stolen
 * from the redirect — browser history, a shoulder-surfed URL — is worthless without the
 * verifier, which only the process that started the login has ever held.
 */
export async function exchangeCliAuth(
  sql: HubSqlPool, input: ExchangeCliAuthInput,
): Promise<CliTokenIssued> {
  return withTransaction(sql, async (tx) => {
    // Consume first, under the row lock: a replay of the same code must lose here rather
    // than after the checks below, where two callers could both pass and both be issued a
    // token for one approval.
    const consumed = await tx.query<{ challenge: string; code_hash: string; user_id: string; label: string }>(
      `UPDATE cli_auth_requests
          SET consumed_at = now()
        WHERE id = $1 AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at > now()
        RETURNING challenge, code_hash, user_id, label`,
      [input.requestId],
    )
    if (consumed.rows.length === 0) {
      throw new ForbiddenError('this login request is unknown, not approved, already used, or has expired')
    }
    const row = consumed.rows[0]
    // Both failures below leave the request consumed. That is deliberate: a wrong verifier
    // or a wrong code means someone is guessing, and burning the request stops them from
    // guessing again against it.
    if (!sameDigest(row.code_hash, sha256(input.code))) {
      throw new ForbiddenError('this login could not be completed')
    }
    if (!sameDigest(row.challenge, sha256(input.verifier))) {
      throw new ForbiddenError('this login could not be completed')
    }
    const token = `${CLI_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    await tx.query(
      `INSERT INTO cli_tokens (id, user_id, token_hash, label) VALUES ($1, $2, $3, $4)`,
      [`clitok_${randomUUID()}`, row.user_id, sha256(token), row.label],
    )
    return { token, userId: row.user_id }
  })
}

export interface CliPrincipal { tokenId: string; userId: string }

export async function verifyCliToken(sql: HubSql, token: string): Promise<CliPrincipal> {
  if (!token.startsWith(CLI_TOKEN_PREFIX)) throw new ForbiddenError('not a CLI token')
  const found = await sql.query<{ id: string; user_id: string; revoked_at: string | null }>(
    `SELECT id, user_id, revoked_at FROM cli_tokens WHERE token_hash = $1`,
    [sha256(token)],
  )
  const row = found.rows[0]
  if (!row || row.revoked_at) throw new ForbiddenError('CLI token is unknown or revoked')
  // Best-effort: a failed touch must never fail the request it was observing.
  await sql.query(`UPDATE cli_tokens SET last_used_at = now() WHERE id = $1`, [row.id])
    .catch(() => undefined)
  return { tokenId: row.id, userId: row.user_id }
}

export interface UserOrg { org_id: string; name: string; role: string }

/** Every org this person belongs to — the list `orchestra org connect` chooses from. */
export async function listUserOrgs(sql: HubSql, userId: string): Promise<UserOrg[]> {
  const found = await sql.query<UserOrg>(
    `SELECT o.id AS org_id, o.name, m.role
       FROM memberships m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = $1
      ORDER BY o.name ASC, o.id ASC`,
    [userId],
  )
  return found.rows
}

/**
 * The membership a CLI-token mint is metered against. Resolving it here is what keeps the
 * seat cap honest: `mintDeviceToken` only enforces the cap when it is given a membership,
 * and a CLI token must never be the anonymous minting path that device tokens are forbidden
 * from being (see the route comment in server.ts).
 */
export async function requireCliMembership(
  sql: HubSql, userId: string, orgId: string,
): Promise<{ membershipId: string }> {
  const found = await sql.query<{ id: string }>(
    `SELECT id FROM memberships WHERE user_id = $1 AND org_id = $2`,
    [userId, orgId],
  )
  if (found.rows.length === 0) throw new NotFoundError('you are not a member of this organization')
  return { membershipId: found.rows[0].id }
}
