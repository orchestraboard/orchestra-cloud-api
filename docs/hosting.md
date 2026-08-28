# Hosting Orchestra Cloud

This is the runbook for standing up the hosted, multi-tenant deployment of Orchestra ("Orchestra
Cloud"): a Railway-hosted hub server backed by Supabase Postgres, a Vercel-hosted web UI, Clerk
for auth/orgs, and Stripe for billing. It is written so the whole stack can be rebuilt from
nothing.

Nothing in this document has been exercised against live accounts — see
[Step 8: smoke test](#step-8-smoke-test-unexecuted) for why, and for the checklist to run once
credentials exist.

## Architecture in one paragraph

Browsers only ever talk to two hosts: the Vercel-hosted static SPA (`web/`), and the Railway
hub API it calls over `fetch`/SSE. The hub is the only thing that talks to Postgres, Clerk's
backend API, and Stripe. Clerk and Stripe both push webhooks straight at the hub (never at
Vercel) because a webhook's whole job is to mutate hub state. A daemon (an `orchestra` agent
process running on someone's machine) authenticates to the same hub API as the browser does, just
with a device-token `Authorization: Bearer` header instead of a Clerk session JWT — see
`src/hub/server.ts`'s `onRequest` hook.

```
Browser  ──Clerk session JWT──▶  Railway hub  ──▶  Supabase Postgres (session pooler)
   │                                  │  ▲
   │ (static assets)                  │  │
   ▼                                  │  └── Clerk Backend API (token verify)
Vercel (web/, built with Vite)        │
                                       │
Daemon  ──device-token Bearer──▶──────┘
                                       │
Clerk ──webhook──▶ POST /webhooks/clerk   (Railway hub, NOT Vercel)
Stripe ─webhook──▶ POST /webhooks/stripe  (Railway hub, NOT Vercel)
```

## Provisioning order

Provision in this order — each step's output feeds the next one's environment variables.

1. **Supabase project.** Create the project. Copy the **session pooler** connection string
   (see [Why the session pooler, specifically](#why-the-session-pooler-specifically) below) —
   this becomes `HUB_DATABASE_URL`. Nothing else to configure: the hub runs its own migrations
   (`src/hub/migrations/*.sql`) automatically on boot via `hubMigrate()` — there is no separate
   manual migration step. Plain tables/indexes only, no Postgres extensions required.

2. **Clerk application.** Development instance (see
   [What this plan does NOT do](#not-in-scope) — a production Clerk instance is a deliberate
   follow-up, not an oversight). Enable **Organizations**. Note the publishable key and secret
   key. Do not configure webhooks yet — the hub's public URL doesn't exist until step 4.

3. **Stripe account, test mode.** Create the ten prices `src/hub/billing.ts` sells, each with a
   **lookup key** exactly matching the ones in `LOOKUP_KEYS` (billing.ts) — the hub resolves
   prices by lookup key, never by hardcoded Stripe price id, specifically so the same code works
   in test and live mode:

   ```
   cloud_base_monthly       cloud_base_yearly
   cloud_seat_monthly       cloud_seat_yearly
   cloud_agent_pack_monthly cloud_agent_pack_yearly
   cloud_sso_monthly        cloud_sso_yearly
   business_seat_monthly    business_seat_yearly
   ```

   Note the (test-mode) secret key. Do not configure webhooks yet, same reason as Clerk.

4. **Railway service.** Deploy this repo's `Dockerfile` (already present, already correct — see
   [Railway config](#railway-config)). Set the environment variables below. Once it has a public
   URL and passes `/healthz`, note that URL — it's `HUB_BASE_URL` for the record, and it's what
   both webhooks (step 6) point at.

5. **Vercel project.** Deploy `web/` using the root `vercel.json` (see
   [Vercel config](#vercel-config)). Set the two build-time env vars. Once it has a public URL,
   go back to Railway and set `WEB_ORIGIN` to that exact URL (protocol + host, no trailing
   slash — see [CORS is exact-match](#cors-is-exact-match) below), then redeploy Railway so CORS
   picks it up.

6. **Webhooks**, now that the Railway URL is stable — see
   [Webhook endpoints](#webhook-endpoints).

7. **Cross-check the redirect domain** — see
   [Known limitation: hardcoded checkout/portal redirect domain](#known-limitation-hardcoded-checkoutportal-redirect-domain)
   before declaring this done. It is easy to miss because nothing fails loudly.

8. [Smoke test](#step-8-smoke-test-unexecuted).

### Why the session pooler, specifically

Supabase offers two pgbouncer pool modes. **Use the session pooler URI, not the transaction
pooler.** The hub's migration runner (`src/hub/migrations.ts`) takes a `pg_advisory_lock` — which
is **session-scoped** — and then runs `BEGIN` / DDL / `COMMIT` as a multi-statement transaction
**on that same connection**. The transaction pooler recycles the underlying connection between
statements, so:

- the advisory lock can silently apply to a different physical connection than the one running
  the migration, defeating the "serialize concurrent boots" protection it exists for, and
- `BEGIN ... COMMIT` across statements simply doesn't work — Supabase's transaction pooler
  rejects or silently breaks session state that isn't a single implicit transaction.

This fails **confusingly**, not obviously: migrations may appear to partially apply, or the
process may hang on the advisory lock acquisition, or later requests may get connection errors
that look like a Postgres outage. If Railway logs show anything strange on first boot, check the
pooler mode before anything else.

## Environment variables

| Variable | Set on | Required | Notes |
|---|---|---|---|
| `HUB_DATABASE_URL` | Railway | yes | Supabase **session pooler** URI. `DATABASE_URL` also works as a fallback name (`src/hub/env.ts`) but prefer the explicit `HUB_` name to avoid colliding with a platform-injected `DATABASE_URL`. |
| `PORT` | Railway | no | Railway injects this automatically; the hub binds `0.0.0.0:$PORT` (`src/hub-entry.ts`). Defaults to 4760 if unset. Don't set it by hand on Railway. |
| `WEB_ORIGIN` | Railway | yes (for the browser to work at all) | The exact Vercel origin, e.g. `https://orchestra-web.vercel.app` — scheme + host, **no trailing slash, no path**. CORS is an exact string match (`src/hub/cors.ts`); anything else and the browser silently loses all cross-origin requests. |
| `HUB_BASE_URL` | Railway | no | Read into `HubEnv` (`src/hub/env.ts`) but **not currently consumed anywhere** in `src/hub-entry.ts` or `src/hub/server.ts` — nothing breaks if it's unset. Setting it to the Railway public URL anyway costs nothing and documents intent for whoever reads the Railway dashboard next. |
| `CLERK_SECRET_KEY` | Railway | yes (to accept browser/API auth) | Server-side Clerk secret key. Verifies session JWTs (`src/hub/clerk.ts`) and signs the hub's own Clerk Backend API calls. |
| `CLERK_PUBLISHABLE_KEY` | Railway | no | Read into `HubEnv` but **not used anywhere in the hub server** — the hub never needs it (it verifies tokens with the secret key only). Safe to omit on Railway; the browser needs its own copy, see `VITE_CLERK_PUBLISHABLE_KEY` below. |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Railway | yes (to accept the Clerk webhook) | From the Clerk webhook endpoint's signing secret (step 6). Without it, `POST /webhooks/clerk` always answers 500 rather than accept an unsigned payload — Clerk retries until it's set. |
| `STRIPE_SECRET_KEY` | Railway | yes (for billing) | Test-mode secret key while `not in scope` production Clerk/Stripe live mode is deferred (see [What this plan does NOT do](#not-in-scope)). |
| `STRIPE_WEBHOOK_SECRET` | Railway | yes (to accept the Stripe webhook) | From the Stripe webhook endpoint's signing secret (step 6). Same fail-closed behavior as the Clerk webhook secret. |
| `VITE_HUB_BASE_URL` | Vercel (**build-time**) | yes | The Railway hub's public URL. Baked into the JS bundle at build time by Vite — see [Vite env vars are build-time, not runtime](#vite-env-vars-are-build-time-not-runtime). |
| `VITE_CLERK_PUBLISHABLE_KEY` | Vercel (**build-time**) | yes | Clerk's publishable key, browser-safe by design. Also build-time — same caveat. |

### Vite env vars are build-time, not runtime

`VITE_HUB_BASE_URL` and `VITE_CLERK_PUBLISHABLE_KEY` are read via `import.meta.env` in
`web/src/hubApi.ts` and `web/src/main.tsx`. Vite **inlines** `import.meta.env.VITE_*` values into
the built JS at `vite build` time — they are not read from the environment when the server
answers a request the way a typical backend `process.env` read would be. This means:

- **Changing either value in the Vercel dashboard does nothing until the next build.** There is
  no running process to restart; the static files already on the CDN keep serving the old value
  baked in.
- After changing either variable, trigger a new deployment (push a commit, or use Vercel's
  "Redeploy" — but note **redeploy alone is not enough** if it reuses a cached build; force a
  fresh build) to actually pick up the new value.
- This is the kind of thing that silently wastes an afternoon: the dashboard shows the "correct"
  new value, the app keeps behaving like the old one, and there's no error anywhere.

## Vercel config

`vercel.json` (repo root):

```json
{
  "framework": "vite",
  "installCommand": "npm ci --prefix web",
  "buildCommand": "npm run build --prefix web",
  "outputDirectory": "web/dist"
}
```

**Leave the Vercel project's "Root Directory" setting at its default (the repository root) —
do not set it to `web`.** This is a deliberate deviation from the more obvious "point Root
Directory at `web/`" approach, for two reasons:

1. Vercel resolves `vercel.json` **inside** the configured Root Directory. If Root Directory
   were set to `web`, this file would need to live at `web/vercel.json` instead of the repo
   root, and the Root Directory toggle itself lives only in the Vercel dashboard — it is not
   captured in any file this repository tracks. That means "redo the whole deployment from
   scratch" would require remembering an undocumented dashboard setting in addition to the
   files in git.
2. With Root Directory left at the repo root, this single `vercel.json` is the entire, git-
   tracked, reproducible deployment config: `--prefix web` scopes install and build to `web/`
   without ever touching the root `package.json`'s dependencies (which include native modules
   Vercel has no reason to compile), and `outputDirectory: "web/dist"` points at exactly what
   `npm run build --prefix web` produces (`vite build && node scripts/compress-dist.mjs dist`,
   per `web/package.json`).

Set `VITE_HUB_BASE_URL` and `VITE_CLERK_PUBLISHABLE_KEY` under Project Settings → Environment
Variables (do **not** put them in `vercel.json` — Vercel's own docs now recommend against the
legacy `env`/`build.env` `vercel.json` fields in favor of the dashboard). Remember: build-time,
not runtime — see above.

## Railway config

`Dockerfile` and `railway.json` already exist in this repo (from Task 1) and were verified as
part of this task, not newly written:

- `Dockerfile` is a two-stage build (`node:22.20-bookworm-slim`, matching the `engines` pin in
  `package.json` exactly so `npm ci` doesn't fail the engines check) that never copies a host
  `node_modules` — native deps (`better-sqlite3`, `node-pty`) get compiled for Railway's
  platform, not the developer's machine. `HEALTHCHECK` hits `/healthz`, which is deliberately
  unauthenticated (`src/hub/server.ts`).
- `railway.json` points the builder at that `Dockerfile`, runs `npm start` (→
  `node dist/hub-entry.js`), and points Railway's own health check at `/healthz` too.

Nothing needed changing here. Set the Railway service's environment variables per the table
above. Railway injects `PORT` itself — don't set it manually.

## Webhook endpoints

Both webhooks point at the **Railway hub**, never at Vercel — they mutate database state
directly, and Vercel serves static files with no backend of its own to receive them.

| Provider | URL | Signing secret env var | Events to subscribe |
|---|---|---|---|
| Clerk | `https://<railway-url>/webhooks/clerk` | `CLERK_WEBHOOK_SIGNING_SECRET` | `user.created`, `user.updated`, `user.deleted`, `organization.created`, `organization.updated`, `organization.deleted`, `organizationMembership.created`, `organizationMembership.updated`, `organizationMembership.deleted` (`src/hub/webhooks/clerk.ts`'s `applyClerkEvent` switch — any other event type is acknowledged as a no-op, so subscribing to extra events is harmless but subscribing to fewer than this list silently stops the mirror from being accurate) |
| Stripe | `https://<railway-url>/webhooks/stripe` | `STRIPE_WEBHOOK_SECRET` | `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` (`src/hub/webhooks/stripe.ts`'s `applyStripeEvent` switch) |

Both routes carry their own signature verification (Svix for Clerk, Stripe's own HMAC scheme)
instead of the hub's bearer-token auth — they're mounted outside `/api/v1/hub/*` specifically so
the `onRequest` auth hook never applies to them. Both fail closed with a 500 (not a silent 200) if
their signing secret env var isn't set, so Clerk/Stripe keep retrying instead of giving up.

## Known limitation: hardcoded checkout/portal redirect domain

`src/hub/billing.ts`'s `createCheckoutSession` and `createPortalSession` fall back to a
**hardcoded** `success_url`/`cancel_url`/`return_url` of `https://app.orchestraboard.dev/...`
when the caller doesn't supply one — and `src/hub/server.ts`'s route handlers for both
(`POST /orgs/:orgId/billing/checkout` and the portal equivalent) don't supply one, so that
hardcoded default is what real checkout/portal sessions actually use today. This file's
`deriveQuantities` function is reviewed/frozen for this task, and this URL default lives outside
that function, but it is still existing, already-shipped behavior this task did not introduce
and was not asked to change.

**Practical effect:** unless the Vercel deployment's origin is exactly `app.orchestraboard.dev`,
a customer completing Stripe Checkout (or leaving the billing portal) gets redirected to a domain
that doesn't resolve to this deployment. The subscription itself still activates correctly —
that's driven by the Stripe **webhook**, completely independent of whether the browser redirect
succeeds — but the customer's browser dead-ends instead of landing back on the board.

Two ways to close this, neither implemented here (out of scope for a deploy-config task, and
`billing.ts` route handlers weren't cleared for edits in this task's brief):

- **Recommended:** add a Vercel custom domain matching `app.orchestraboard.dev` (Project Settings
  → Domains) so the hardcoded default resolves correctly. This does not conflict with
  ["no custom domains" in What this plan does NOT do](#not-in-scope) — that item is about the
  **hub's** own domain (Railway), not the web app's.
- Or: accept the limitation for this deployment and have `server.ts`'s checkout/portal handlers
  pass `successUrl`/`cancelUrl`/`returnUrl` built from `WEB_ORIGIN` in a follow-up task — this
  would touch reviewed billing route code, so treat it as a separate, reviewed change.

## Local single-machine mode is unaffected

None of this changes `orchestra serve` (`src/server.ts`) or the desktop/local flow at all. With no
`HUB_DATABASE_URL`/`DATABASE_URL` set, `orchestra hub` simply refuses to start (`hubEnv()` throws)
— it's an entirely separate binary entrypoint (`dist/hub-entry.js`) from the local daemon
(`src/cli.ts` → `src/server.ts`), sharing conventions but no code, per `src/hub/server.ts`'s own
doc comment.

## Step 8: smoke test (UNEXECUTED)

**This has not been run.** The operator has not yet created the Supabase, Railway, or Vercel
projects in this environment, and holds no Clerk secret key or Stripe restricted key here. Do
not treat anything below as verified — it is a checklist to execute once those accounts exist,
written to be followed literally, with the expected result at each step.

There is no `orchestra hub join <url> <token>` CLI command in this codebase yet — a daemon
authenticates to the hub's REST API with a device-token `Authorization: Bearer` header
(`src/hub/server.ts`), the same way the browser does with a Clerk session JWT. Steps 5–7 below
therefore simulate "a daemon" with `curl` against that API rather than assuming a client command
that doesn't exist. If a real daemon-join CLI lands later, replace steps 5–7 with it and keep the
rest.

1. **Sign up.** Open the Vercel URL. Sign up via Clerk's hosted UI.
   *Expected:* Clerk redirects back into the app; `ClerkAuthControls`
   (`web/src/ClerkAuthControls.tsx`) shows a signed-in state.

2. **Create an org.** Use Clerk's org creation UI (via `@clerk/react`'s org switcher/creator).
   *Expected:* An `organization.created` webhook fires; check Railway logs for
   `POST /webhooks/clerk` returning `200`, and confirm a row now exists in Supabase's `orgs`
   table with a matching `clerk_org_id`.

3. **Pay in Stripe test mode.** From the app's billing page, click "Upgrade / add seats" (an org
   with no plan yet — tier `'none'` — always goes through the Cloud checkout path; see the
   `BillingPage.tsx` tier-aware fix in this task's report). Complete checkout with Stripe's test
   card `4242 4242 4242 4242`, any future expiry, any CVC.
   *Expected:* Redirect lands on the hardcoded `app.orchestraboard.dev` URL (see
   [Known limitation](#known-limitation-hardcoded-checkoutportal-redirect-domain) — this is
   expected to 404/dead-end unless that domain is configured). Regardless of where the browser
   lands, check Railway logs for `POST /webhooks/stripe` (`checkout.session.completed`)
   returning `200`, and confirm Supabase's `subscriptions` table now has a row for this org with
   `tier = 'cloud'` and `status = 'active'`.

4. **Confirm entitlements reflect the purchase.** Reload the billing page.
   *Expected:* Plan shows "Cloud"; seat/agent meters reflect `cloud_base_monthly`'s fixed 3
   included seats (`deriveQuantities` in `billing.ts`).

5. **Mint a device token** (simulating "join a daemon"). While signed in as an org member, call:
   ```bash
   curl -X POST "https://<railway-url>/api/v1/hub/orgs/<orgId>/devices" \
     -H "Authorization: Bearer <clerk-session-jwt>" \
     -H "Content-Type: application/json" \
     -d '{"name": "smoke-test-daemon"}'
   ```
   *Expected:* `200` with a `token` field prefixed `orchestra_device_v1.`. Save it as
   `$DEVICE_TOKEN`.

6. **Create a card "from one machine"** using that device token as the daemon would:
   ```bash
   curl -X POST "https://<railway-url>/api/v1/hub/orgs/<orgId>/ops" \
     -H "Authorization: Bearer $DEVICE_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"op": "card.create", "payload": {"boardId": "<boardId>", "title": "smoke test card"}}'
   ```
   *Expected:* `200` with the created card and a `seq`. (`<boardId>` must already exist for the
   org — get one from `GET /api/v1/hub/orgs/<orgId>/cards` or the app's own board view.)

7. **See it on another machine.** In a **second** browser session (or a private window) signed in
   as a different member of the same org, open the board.
   *Expected:* "smoke test card" appears without a manual refresh — this is what
   `GET /orgs/:orgId/sync` (`src/hub/routes/sync.ts`) exists for. If it only appears after a
   manual reload, the sync/broadcast path — not this task's deploy config — is the thing to
   debug.

8. **Suspended org serves reads, refuses writes** (explicit Done Criteria item). In the Stripe
   dashboard, cancel the test subscription (or let it lapse). Confirm the `customer.subscription.
   deleted` webhook flips `orgs.status` to `'suspended'` (`syncSubscriptionFromStripe`).
   *Expected:* `GET /api/v1/hub/orgs/<orgId>/cards` still returns `200`; `POST .../ops` returns
   an error from `assertOrgWritable` (`src/hub/entitlements.ts`) rather than succeeding.

9. **Removing a member in Clerk revokes their device token** (explicit Done Criteria item).
   Remove the smoke-test member from the org via Clerk's dashboard.
   *Expected:* The `organizationMembership.deleted` webhook cascades `memberships` →
   `devices` (`ON DELETE CASCADE`); the same `$DEVICE_TOKEN` from step 5 now gets `403` on any
   `/api/v1/hub/...` call.

Record the actual result of each numbered step here once run — pass/fail, and for a failure, the
exact response body/log line, not a paraphrase.

## What this plan does NOT do

Production Clerk instance (development keys are deliberate for now), custom domains **for the
hub** (Railway), per-seat proration edge cases, SSO enforcement beyond the entitlement flag, and
multi-region/HA. All are follow-ups. (The Vercel custom-domain recommendation above, for the
checkout-redirect limitation, is about the web app's domain, not the hub's — it doesn't
contradict this.)
