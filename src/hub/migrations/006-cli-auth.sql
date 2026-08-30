-- CLI login: the browser-to-terminal handoff, and the long-lived token it produces.
-- Pure DDL with no multi-statement constructs: the PGlite test path splits this file on ';'.

-- One row per `orchestra login` attempt. Short-lived by design (see expires_at) and
-- single-use: `consumed_at` is set by a conditional UPDATE so two exchanges of the same
-- code cannot both succeed.
CREATE TABLE IF NOT EXISTS cli_auth_requests (
  id text PRIMARY KEY,
  -- base64url(sha256(verifier)); the verifier itself never leaves the CLI, so a stolen
  -- code cannot be exchanged by whoever stole it.
  challenge text NOT NULL,
  -- machine name shown to the human before they approve ("mac"), never trusted for auth
  label text NOT NULL,
  code_hash text,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS cli_auth_requests_expires_idx ON cli_auth_requests (expires_at);

-- The credential `orchestra login` leaves behind. Only its sha256 is stored, matching the
-- rule devices.ts already follows: a database read must not be enough to impersonate anyone.
CREATE TABLE IF NOT EXISTS cli_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS cli_tokens_user_idx ON cli_tokens (user_id);
