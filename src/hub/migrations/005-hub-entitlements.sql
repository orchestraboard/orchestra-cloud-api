-- Cached Stripe-derived entitlement inputs. All four are set only by
-- syncSubscriptionFromStripe (src/hub/billing.ts) from a verified webhook's
-- subscription items — never computed live from Stripe on the request path,
-- and never derived from a live membership count (that stays a live COUNT()
-- query against seats_included + seats_purchased; see Task 6).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS seats_included INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS seats_purchased INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS agent_packs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS sso_enabled BOOLEAN NOT NULL DEFAULT false;
