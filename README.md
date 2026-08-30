# Orchestra Cloud API

The hosted, multi-tenant API for [Orchestra](https://orchestraboard.com). It provides organization-scoped boards, agent presence, device authentication, synchronization, billing, and Clerk/Stripe webhooks for Orchestra Cloud.

## Production contract

- Public origin: `https://api.orchestraboard.com`
- Health check: `GET /healthz`
- API: `/api/v1/hub/*`
- Clerk webhook: `POST /webhooks/clerk`
- Stripe webhook: `POST /webhooks/stripe`
- Hosting: Railway
- Database: Supabase Postgres session pooler

See [`docs/hosting.md`](docs/hosting.md) for the provisioning order and required environment variables.

## Development

Use Node 22.20 and npm 10.9, then run:

```sh
npm ci
npm test
npm run build
```

The Hub fails closed when required database, authentication, billing, or webhook configuration is absent.
