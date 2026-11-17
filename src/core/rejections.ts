import type { Db } from "./db.ts";
import { ulid } from "./ulid.ts";

export const REJECTION_REASONS = [
  "unknown_address",
  "sender_not_allowed",
  "auth_failed",
  "lane_paused",
  "too_large",
  "attachment_not_allowed",
  "parse_error",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const DEFAULT_MAX_REJECTED_PER_DAY = 50;
export const REJECTION_RETENTION_DAYS = 30;

export interface NewRejection {
  bucket: "probe" | "lane";
  recipientHint: string;
  envelopeFrom: string;
  headerFrom: string | null;
  reason: RejectionReason;
  detail?: string | null;
  /** Authentication-header excerpt; only for failures where the envelope sender was allowed. */
  diagnostics?: string | null;
  laneId?: string | null;
}

/** First characters of the local part only: enough to recognise a probe, never a live address. */
export function recipientHint(recipient: string): string {
  const local = recipient.split("@")[0] ?? "";
  return local.length > 8 ? `${local.slice(0, 8)}…` : local;
}

/**
 * Logs headers-only, capped per bucket per rolling day so junk can't fill D1.
 * Probes against unknown addresses and failures on real lanes are capped
 * separately, so a prober can't hide a genuine misconfiguration.
 * Returns whether a row was written. Never throws.
 */
export async function logRejection(db: Db, r: NewRejection, cap: number, now: Date = new Date()): Promise<boolean> {
  try {
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    const row = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM rejections WHERE bucket = ? AND received_at > ?", [
      r.bucket,
      since,
    ]);
    if ((row?.n ?? 0) >= cap) return false;
    await db.run(
      `INSERT INTO rejections (id, received_at, bucket, recipient_hint, envelope_from, header_from, reason, detail, diagnostics, lane_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ulid(now.getTime()),
        now.toISOString(),
        r.bucket,
        r.recipientHint,
        r.envelopeFrom.slice(0, 320),
        r.headerFrom?.slice(0, 320) ?? null,
        r.reason,
        r.detail?.slice(0, 300) ?? null,
        r.diagnostics?.slice(0, 2000) ?? null,
        r.laneId ?? null,
      ],
    );
    return true;
  } catch {
    return false;
  }
}

export interface RejectionRow {
  id: string;
  received_at: string;
  bucket: string;
  recipient_hint: string;
  envelope_from: string;
  header_from: string | null;
  reason: string;
  detail: string | null;
  diagnostics: string | null;
  lane_id: string | null;
  lane_slug: string | null;
}

export async function listRejections(db: Db, opts: { laneId?: string; limit?: number } = {}): Promise<RejectionRow[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.laneId) {
    where.push("r.lane_id = ?");
    params.push(opts.laneId);
  }
  params.push(Math.max(1, Math.min(opts.limit ?? 25, 200)));
  return db.all<RejectionRow>(
    `SELECT r.*, l.slug AS lane_slug FROM rejections r LEFT JOIN lanes l ON l.id = r.lane_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.received_at DESC LIMIT ?`,
    params,
  );
}

export async function purgeRejections(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - REJECTION_RETENTION_DAYS * 86_400_000).toISOString();
  return (await db.run("DELETE FROM rejections WHERE received_at < ?", [cutoff])).changes;
}
