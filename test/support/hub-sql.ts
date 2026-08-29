import { PGlite } from '@electric-sql/pglite'
import { hubMigrate } from '../../src/hub/migrations.js'
import type { HubSql } from '../../src/hub/sql.js'

/** A migrated, in-process Postgres. No Docker, no live DB, one per test. */
export async function hubTestSql(): Promise<HubSql> {
  const db = new PGlite()
  const sql: HubSql = {
    query: async (text, params) => {
      const result = await db.query(text, params ? [...params] : undefined)
      const rows = (result.rows ?? []) as any[]
      return { rows, rowCount: rows.length }
    },
  }
  await hubMigrate(sql)
  return sql
}

/** `clerkOrgId` is optional and only needed by tests that authenticate as a Clerk principal. */
export async function seedOrg(sql: HubSql, orgId: string, clerkOrgId?: string): Promise<void> {
  await sql.query('INSERT INTO orgs (id, name, slug, clerk_org_id) VALUES ($1, $2, $3, $4)', [
    orgId, orgId, orgId, clerkOrgId ?? null,
  ])
}

export async function seedBoard(sql: HubSql, orgId: string, boardId: string): Promise<void> {
  await sql.query('INSERT INTO projects (id, org_id, name) VALUES ($1, $2, $3)', [`proj_${boardId}`, orgId, boardId])
  await sql.query('INSERT INTO boards (id, org_id, project_id, name) VALUES ($1, $2, $3, $4)', [
    boardId, orgId, `proj_${boardId}`, boardId,
  ])
}

/** Mirrors a Clerk user directly with SQL — Task 4 (not built yet) is what will populate this from webhooks. */
export async function seedUser(sql: HubSql, userId: string, clerkUserId: string, email = `${userId}@example.com`): Promise<void> {
  await sql.query('INSERT INTO users (id, clerk_user_id, email) VALUES ($1, $2, $3)', [userId, clerkUserId, email])
}

/** Mirrors a Clerk org membership directly with SQL, for the same reason as `seedUser`.
 * `role` defaults to the schema's own default so every pre-existing caller is unchanged;
 * pass `'owner'`/`'admin'` for the routes that gate on role (see `requireMembership` in
 * src/hub/server.ts). */
export async function seedMembership(
  sql: HubSql, membershipId: string, orgId: string, userId: string, role: 'owner' | 'admin' | 'member' = 'member',
): Promise<void> {
  await sql.query('INSERT INTO memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)', [
    membershipId, orgId, userId, role,
  ])
}

export interface SeedSubscriptionOptions {
  tier?: 'cloud' | 'business' | 'none'
  status?: string
  stripeCustomerId?: string
  stripeSubscriptionId?: string | null
  seatsIncluded?: number
  seatsPurchased?: number
  agentPacks?: number
}

/**
 * Gives an org a `subscriptions` row, the way a verified Stripe webhook would.
 *
 * Needed by any test that WRITES through the ops endpoint: `assertOrgWritable`
 * (src/hub/entitlements.ts) refuses an org that has never had a subscription at all, so an
 * org seeded by `seedOrg` alone is deliberately read-only. Tests that assert on the
 * never-subscribed state itself must not call this.
 */
export async function seedSubscription(sql: HubSql, orgId: string, options: SeedSubscriptionOptions = {}): Promise<void> {
  await sql.query(
    `INSERT INTO subscriptions
       (org_id, stripe_customer_id, stripe_subscription_id, status, tier, seats_included, seats_purchased, agent_packs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (org_id) DO UPDATE SET
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       status = excluded.status,
       tier = excluded.tier,
       seats_included = excluded.seats_included,
       seats_purchased = excluded.seats_purchased,
       agent_packs = excluded.agent_packs`,
    [
      orgId,
      options.stripeCustomerId ?? `cus_${orgId}`,
      options.stripeSubscriptionId === undefined ? `sub_${orgId}` : options.stripeSubscriptionId,
      options.status ?? 'active',
      options.tier ?? 'cloud',
      options.seatsIncluded ?? 3,
      options.seatsPurchased ?? 0,
      options.agentPacks ?? 0,
    ],
  )
}
