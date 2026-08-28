import { describe, it, expect } from 'vitest'
import { hubEnv } from '../src/hub/env.js'

describe('hubEnv', () => {
  it('throws naming HUB_DATABASE_URL when nothing is configured', () => {
    expect(() => hubEnv({})).toThrow(/HUB_DATABASE_URL/)
  })

  it('falls back to DATABASE_URL when HUB_DATABASE_URL is unset', () => {
    const env = hubEnv({ DATABASE_URL: 'postgres://example/hub' })
    expect(env.databaseUrl).toBe('postgres://example/hub')
  })

  it('parses a full environment, leaving Clerk/Stripe optional', () => {
    const env = hubEnv({
      HUB_DATABASE_URL: 'postgres://example/hub',
      PORT: '8080',
      WEB_ORIGIN: 'https://app.example.com',
      HUB_BASE_URL: 'https://hub.example.com',
      CLERK_SECRET_KEY: 'sk_test_secret',
      CLERK_PUBLISHABLE_KEY: 'pk_test_publishable',
      CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_secret',
      STRIPE_SECRET_KEY: 'sk_stripe_secret',
      STRIPE_WEBHOOK_SECRET: 'whsec_stripe_secret',
    })

    expect(env).toEqual({
      databaseUrl: 'postgres://example/hub',
      port: 8080,
      webOrigin: 'https://app.example.com',
      hubBaseUrl: 'https://hub.example.com',
      clerkSecretKey: 'sk_test_secret',
      clerkPublishableKey: 'pk_test_publishable',
      clerkWebhookSigningSecret: 'whsec_secret',
      stripeSecretKey: 'sk_stripe_secret',
      stripeWebhookSecret: 'whsec_stripe_secret',
    })
  })

  it('defaults PORT to 4760 and leaves optional fields undefined', () => {
    const env = hubEnv({ HUB_DATABASE_URL: 'postgres://example/hub' })
    expect(env.port).toBe(4760)
    expect(env.webOrigin).toBeUndefined()
    expect(env.hubBaseUrl).toBeUndefined()
    expect(env.clerkSecretKey).toBeUndefined()
    expect(env.stripeSecretKey).toBeUndefined()
  })

  it('prefers PORT over the default', () => {
    const env = hubEnv({ HUB_DATABASE_URL: 'postgres://example/hub', PORT: '9999' })
    expect(env.port).toBe(9999)
  })

  it('rejects a malformed PORT', () => {
    expect(() => hubEnv({ HUB_DATABASE_URL: 'postgres://example/hub', PORT: 'not-a-port' })).toThrow(/PORT/)
    expect(() => hubEnv({ HUB_DATABASE_URL: 'postgres://example/hub', PORT: '0' })).toThrow(/PORT/)
    expect(() => hubEnv({ HUB_DATABASE_URL: 'postgres://example/hub', PORT: '70000' })).toThrow(/PORT/)
  })

  it('never includes a secret value in the thrown message', () => {
    const secretValues = [
      'postgres://user:supersecretpassword@host/db',
      'sk_test_shouldnotleak',
      'whsec_shouldnotleak',
    ]
    const env = {
      HUB_DATABASE_URL: secretValues[0],
      CLERK_SECRET_KEY: secretValues[1],
      STRIPE_WEBHOOK_SECRET: secretValues[2],
      PORT: 'garbage',
    }

    let thrown: Error | undefined
    try {
      hubEnv(env)
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown).toBeDefined()
    for (const secret of secretValues) {
      expect(thrown!.message).not.toContain(secret)
    }
  })

  it('never includes the missing database URL variable\'s sibling values in the "missing" message', () => {
    let thrown: Error | undefined
    try {
      hubEnv({ CLERK_SECRET_KEY: 'sk_test_shouldnotleak' })
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown!.message).toContain('HUB_DATABASE_URL')
    expect(thrown!.message).not.toContain('sk_test_shouldnotleak')
  })
})
