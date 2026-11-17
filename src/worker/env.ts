export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  /** Hostname that receives lane mail (config only; never committed). */
  MAIL_HOSTNAME: string;
  /** Comma-separated envelope senders allowed on lanes by default. */
  DEFAULT_ALLOWED_SENDERS: string;
  /** Comma-separated domains whose DKIM pass is required. */
  ALLOWED_DKIM_DOMAINS: string;
}
