-- Signing keys for the HTTP ingest endpoint (POST /ingest/lanes/:slug). Each key is scoped to
-- one lane and can only add messages to it. HMAC needs the secret itself, so it is stored
-- encrypted to the Worker's ingest key pair (see core/ingest-keys.ts); only the Worker can
-- decrypt it.
CREATE TABLE ingest_keys (
  id TEXT PRIMARY KEY,                             -- public key id, sent as X-Signature-Key-Id
  lane_id TEXT NOT NULL,
  secret_box TEXT NOT NULL,                        -- encrypted secret; never the plain value
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_ingest_keys_lane ON ingest_keys (lane_id, revoked_at);

-- Deployment-wide values that are not secret, such as the ingest public key.
CREATE TABLE settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Where a message came from: 'email' (Email Routing) or 'api' (the ingest endpoint).
ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'email';
ALTER TABLE messages ADD COLUMN ingest_key_id TEXT;
-- Set for API messages only, so a repeat of the same message is recognised.
ALTER TABLE messages ADD COLUMN message_id_header TEXT;
ALTER TABLE messages ADD COLUMN body_sha256 TEXT;
CREATE UNIQUE INDEX idx_messages_api_dedupe ON messages (lane_id, message_id_header, body_sha256)
  WHERE message_id_header IS NOT NULL AND body_sha256 IS NOT NULL;
