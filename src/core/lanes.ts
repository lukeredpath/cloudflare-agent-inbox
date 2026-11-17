import type { Db } from "./db.ts";
import {
  AttachmentPolicy,
  type ForwardedFromRule,
  LaneInput,
  LanePatch,
  type AttachmentPolicy as AttachmentPolicyType,
} from "./lane-config.ts";
import { generateAddressToken } from "./tokens.ts";
import { ulid } from "./ulid.ts";

export class CoreError extends Error {}

export interface Lane {
  id: string;
  slug: string;
  description: string;
  addressToken: string;
  status: "active" | "paused";
  /** null = use the deployment default. */
  allowedSenders: string[] | null;
  attachmentPolicy: AttachmentPolicyType;
  /** Original senders accepted when mail arrives via a trusted forwarder. */
  forwardedFrom: ForwardedFromRule[];
  shareable: boolean;
  maxBytes: number;
  maxTextChars: number;
  retentionDays: number;
  createdAt: string;
  updatedAt: string;
}

interface LaneRow {
  id: string;
  slug: string;
  description: string;
  address_token: string;
  status: string;
  allowed_senders: string | null;
  attachment_policy: string;
  forwarded_from: string | null;
  shareable: number;
  max_bytes: number;
  max_text_chars: number;
  retention_days: number;
  created_at: string;
  updated_at: string;
}

function fromRow(row: LaneRow): Lane {
  return {
    id: row.id,
    slug: row.slug,
    description: row.description,
    addressToken: row.address_token,
    status: row.status === "paused" ? "paused" : "active",
    allowedSenders: row.allowed_senders ? (JSON.parse(row.allowed_senders) as string[]) : null,
    attachmentPolicy: AttachmentPolicy.parse(JSON.parse(row.attachment_policy)),
    forwardedFrom: row.forwarded_from ? (JSON.parse(row.forwarded_from) as ForwardedFromRule[]) : [],
    shareable: row.shareable === 1,
    maxBytes: row.max_bytes,
    maxTextChars: row.max_text_chars,
    retentionDays: row.retention_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const isUniqueViolation = (e: unknown) => /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));

export async function createLane(db: Db, input: unknown): Promise<Lane> {
  const parsed = LaneInput.parse(input);
  const now = new Date().toISOString();
  const id = ulid();
  const token = generateAddressToken();
  try {
    await db.run(
      `INSERT INTO lanes (id, slug, description, address_token, status, allowed_senders, attachment_policy,
                          forwarded_from, shareable, max_bytes, max_text_chars, retention_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        parsed.slug,
        parsed.description,
        token,
        parsed.allowed_senders ? JSON.stringify(parsed.allowed_senders) : null,
        JSON.stringify(parsed.attachment_policy),
        parsed.forwarded_from.length ? JSON.stringify(parsed.forwarded_from) : null,
        parsed.shareable ? 1 : 0,
        parsed.max_bytes,
        parsed.max_text_chars,
        parsed.retention_days,
        now,
        now,
      ],
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new CoreError(`A lane with slug "${parsed.slug}" already exists`);
    throw e;
  }
  return (await getLaneById(db, id))!;
}

export async function getLaneById(db: Db, id: string): Promise<Lane | null> {
  const row = await db.first<LaneRow>("SELECT * FROM lanes WHERE id = ?", [id]);
  return row ? fromRow(row) : null;
}

export async function getLaneBySlug(db: Db, slug: string): Promise<Lane | null> {
  const row = await db.first<LaneRow>("SELECT * FROM lanes WHERE slug = ?", [slug]);
  return row ? fromRow(row) : null;
}

/** The inbound path: lanes are found by address token, never by slug. */
export async function getLaneByToken(db: Db, token: string): Promise<Lane | null> {
  const row = await db.first<LaneRow>("SELECT * FROM lanes WHERE address_token = ?", [token]);
  return row ? fromRow(row) : null;
}

export interface LaneSummary extends Lane {
  messageCount: number;
  unprocessedCount: number;
  lastReceivedAt: string | null;
}

export async function listLanes(db: Db): Promise<LaneSummary[]> {
  const rows = await db.all<LaneRow & { message_count: number; unprocessed_count: number; last_received_at: string | null }>(
    `SELECT l.*,
            (SELECT COUNT(*) FROM messages m WHERE m.lane_id = l.id AND m.deleted_at IS NULL) AS message_count,
            (SELECT COUNT(*) FROM messages m WHERE m.lane_id = l.id AND m.deleted_at IS NULL AND m.processed_at IS NULL) AS unprocessed_count,
            (SELECT MAX(received_at) FROM messages m WHERE m.lane_id = l.id AND m.deleted_at IS NULL) AS last_received_at
       FROM lanes l ORDER BY l.slug`,
  );
  return rows.map((r) => ({
    ...fromRow(r),
    messageCount: r.message_count,
    unprocessedCount: r.unprocessed_count,
    lastReceivedAt: r.last_received_at,
  }));
}

export async function updateLane(db: Db, id: string, patch: unknown): Promise<Lane> {
  const parsed = LanePatch.parse(patch);
  const columns: Record<string, string | number | null> = {};
  if (parsed.description !== undefined) columns.description = parsed.description;
  if (parsed.allowed_senders !== undefined) {
    columns.allowed_senders = parsed.allowed_senders ? JSON.stringify(parsed.allowed_senders) : null;
  }
  if (parsed.attachment_policy !== undefined) columns.attachment_policy = JSON.stringify(parsed.attachment_policy);
  if (parsed.forwarded_from !== undefined) {
    columns.forwarded_from = parsed.forwarded_from.length ? JSON.stringify(parsed.forwarded_from) : null;
  }
  if (parsed.shareable !== undefined) columns.shareable = parsed.shareable ? 1 : 0;
  if (parsed.max_bytes !== undefined) columns.max_bytes = parsed.max_bytes;
  if (parsed.max_text_chars !== undefined) columns.max_text_chars = parsed.max_text_chars;
  if (parsed.retention_days !== undefined) columns.retention_days = parsed.retention_days;

  const names = Object.keys(columns);
  if (names.length === 0) throw new CoreError("Nothing to update");
  const { changes } = await db.run(
    `UPDATE lanes SET ${names.map((n) => `${n} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    [...names.map((n) => columns[n]!), new Date().toISOString(), id],
  );
  if (changes === 0) throw new CoreError("Lane not found");
  return (await getLaneById(db, id))!;
}

export async function setLaneStatus(db: Db, id: string, status: "active" | "paused"): Promise<void> {
  const { changes } = await db.run("UPDATE lanes SET status = ?, updated_at = ? WHERE id = ?", [
    status,
    new Date().toISOString(),
    id,
  ]);
  if (changes === 0) throw new CoreError("Lane not found");
}

/** Issues a new address. The old one stops working immediately. */
export async function rotateLaneToken(db: Db, id: string): Promise<Lane> {
  const { changes } = await db.run("UPDATE lanes SET address_token = ?, updated_at = ? WHERE id = ?", [
    generateAddressToken(),
    new Date().toISOString(),
    id,
  ]);
  if (changes === 0) throw new CoreError("Lane not found");
  return (await getLaneById(db, id))!;
}

/**
 * Removes the lane and its grants now. Its messages are soft-deleted and the
 * daily purge removes them from D1 and R2. The rejection log is kept.
 */
export async function deleteLane(db: Db, id: string): Promise<void> {
  const now = new Date().toISOString();
  const results = await db.batch([
    { sql: "UPDATE messages SET deleted_at = ? WHERE lane_id = ? AND deleted_at IS NULL", params: [now, id] },
    { sql: "DELETE FROM agent_lanes WHERE lane_id = ?", params: [id] },
    { sql: "DELETE FROM lanes WHERE id = ?", params: [id] },
  ]);
  if (results[2]!.changes === 0) throw new CoreError("Lane not found");
}
