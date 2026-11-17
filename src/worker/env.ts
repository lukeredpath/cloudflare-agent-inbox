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
  /** Per-bucket cap on logged rejections per rolling day (default 50). */
  MAX_REJECTED_PER_DAY?: string;
  /** Secrets that lane transforms may reference by name. */
  [secret: `LANE_SECRET_${string}`]: string | undefined;
}
