-- Lanes: one per policy. Looked up by address_token, never by slug alone.
CREATE TABLE lanes (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  address_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',          -- active | paused
  allowed_senders TEXT,                            -- JSON array; NULL = deployment default
  attachment_policy TEXT NOT NULL,                 -- JSON: allowed_types, max_attachment_bytes, transforms
  shareable INTEGER NOT NULL DEFAULT 0,
  max_bytes INTEGER NOT NULL,
  max_text_chars INTEGER NOT NULL,
  retention_days INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,                 -- SHA-256 hex
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE agent_lanes (
  agent_id TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  PRIMARY KEY (agent_id, lane_id)
);

-- No foreign keys on purpose: deleting a lane soft-deletes its messages, which a
-- daily purge removes from D1 and R2 afterwards.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,                             -- ULID
  lane_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  envelope_from TEXT NOT NULL,
  header_from TEXT,
  original_from TEXT,                              -- untrusted: sender of a message forwarded as an attachment
  subject TEXT,                                    -- untrusted
  size INTEGER NOT NULL,
  auth_summary TEXT,
  clean_text TEXT NOT NULL DEFAULT '',             -- untrusted
  raw_key TEXT,                                    -- NULL for injected test messages
  is_test INTEGER NOT NULL DEFAULT 0,
  keep INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  processed_by TEXT,
  processed_note TEXT,
  deleted_at TEXT
);
CREATE INDEX idx_messages_lane ON messages (lane_id, deleted_at, processed_at, received_at);
CREATE INDEX idx_messages_deleted ON messages (deleted_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  parent_id TEXT,                                  -- set for files extracted from an archive
  filename TEXT NOT NULL,                          -- already made safe
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  transform_error TEXT
);
CREATE INDEX idx_attachments_message ON attachments (message_id);

CREATE TABLE shares (
  token_hash TEXT PRIMARY KEY,                     -- SHA-256 hex
  attachment_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_shares_attachment ON shares (attachment_id);
CREATE INDEX idx_shares_expiry ON shares (expires_at);

-- Headers-only log of rejected mail. Nothing rejected is stored beyond this.
CREATE TABLE rejections (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  bucket TEXT NOT NULL,                            -- probe | lane (capped separately)
  recipient_hint TEXT NOT NULL,                    -- truncated; never the full address
  envelope_from TEXT NOT NULL,
  header_from TEXT,
  reason TEXT NOT NULL,
  detail TEXT,
  lane_id TEXT
);
CREATE INDEX idx_rejections_received ON rejections (bucket, received_at);
