-- Cached Stripe-derived entitlement inputs. All five are set only by
-- syncSubscriptionFromStripe (src/hub/billing.ts) from a verified webhook's
-- subscription items — never computed live from Stripe on the request path,
-- and never derived from a live membership count (that stays a live COUNT()
-- query against seats_included + seats_purchased; see Task 6).
--
-- `tier` is explicit rather than inferred (e.g. from seats_included = 0) —
-- a Business org and a misconfigured/partial Cloud checkout can otherwise
-- produce byte-identical seat numbers, and agent packs / SSO are Cloud-only
-- concepts with no defined Business equivalent. 'none' covers a subscription
-- with no line item this hub recognizes yet (see syncSubscriptionFromStripe).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS seats_included INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS seats_purchased INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS agent_packs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS sso_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'none' CHECK (tier IN ('cloud', 'business', 'none'));
