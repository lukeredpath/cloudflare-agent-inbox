export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** Hostname that receives lane mail (config only; never committed). */
  MAIL_HOSTNAME: string;
  /** Hostname that serves the agent MCP. */
  MCP_HOSTNAME: string;
  /** Hostname that serves share links. */
  SHARE_HOSTNAME: string;
  /** Comma-separated envelope senders allowed on lanes by default. */
  DEFAULT_ALLOWED_SENDERS: string;
  /** Comma-separated domains whose DKIM pass is required. */
  ALLOWED_DKIM_DOMAINS: string;
  /** Comma-separated forwarders (e.g. a mailbox provider) whose ARC record of the original sender is trusted. */
  TRUSTED_ARC_FORWARDERS?: string;
  /**
   * Cloudflare's rate-limiting binding. When present, mail from senders that are not on the
   * deployment's allowlist is rate limited before any database work. Optional: without it
   * nothing is limited.
   */
  MAIL_LIMITER?: RateLimit;
  /**
   * The admin interface is optional. It is served on ADMIN_HOSTNAME only when ACCESS_TEAM_DOMAIN and
   * ACCESS_AUD are also set (Cloudflare Access application); otherwise that host answers 503.
   */
  ADMIN_HOSTNAME?: string;
  /** The Access team's hostname, for example `team.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience tag. */
  ACCESS_AUD?: string;
  /** The built admin app (Workers Static Assets). Only reached through the Access check. */
  ASSETS?: Fetcher;
  /**
   * The HTTP ingest endpoint is optional. It is served on INGEST_HOSTNAME only when
   * ACCESS_TEAM_DOMAIN, INGEST_ACCESS_AUD and INGEST_PRIVATE_KEY are also set; otherwise that
   * host answers 503.
   */
  INGEST_HOSTNAME?: string;
  /** Audience tag of the Access application (service tokens) in front of INGEST_HOSTNAME. */
  INGEST_ACCESS_AUD?: string;
  /** Secret: the private half of the ingest key pair, as a JSON JWK. Set by `ingest-keys init`. */
  INGEST_PRIVATE_KEY?: string;
  /** Rate limit per ingest key. Optional: without it nothing is limited. */
  INGEST_LIMITER?: RateLimit;
  /** Per-bucket cap on logged rejections per rolling day (default 50). */
  MAX_REJECTED_PER_DAY?: string;
  /** Secrets that lane transforms may reference by name. */
  [secret: `LANE_SECRET_${string}`]: string | undefined;
}
