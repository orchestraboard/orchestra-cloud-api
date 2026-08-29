import { ValidationError } from './errors.js'

/**
 * Typed hub configuration read from `process.env` (or an injected map for tests).
 * Clerk and Stripe fields are optional here on purpose: this task ships and
 * deploys the hub before billing/auth exist. The tasks that add Clerk/Stripe
 * are expected to re-validate these as required once they land.
 */
export interface HubEnv {
  databaseUrl: string
  port: number
  webOrigin?: string
  hubBaseUrl?: string
  clerkSecretKey?: string
  clerkPublishableKey?: string
  clerkWebhookSigningSecret?: string
  stripeSecretKey?: string
  stripeWebhookSecret?: string
}

/**
 * Reads and validates the hub's environment. Throws `ValidationError` naming
 * any missing required variable — never the variable's value, since these
 * error messages can end up in logs or crash reports.
 */
export function hubEnv(env: NodeJS.ProcessEnv = process.env): HubEnv {
  const databaseUrl = env.HUB_DATABASE_URL ?? env.DATABASE_URL
  if (!databaseUrl) {
    throw new ValidationError('HUB_DATABASE_URL (or DATABASE_URL) must be set to run the hub')
  }

  return {
    databaseUrl,
    port: parsePort(env.PORT),
    webOrigin: env.WEB_ORIGIN,
    hubBaseUrl: env.HUB_BASE_URL,
    clerkSecretKey: env.CLERK_SECRET_KEY,
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY,
    clerkWebhookSigningSecret: env.CLERK_WEBHOOK_SIGNING_SECRET,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
  }
}

const DEFAULT_PORT = 4760

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ValidationError(`PORT must be a valid port number, got ${JSON.stringify(raw)}`)
  }
  return port
}
