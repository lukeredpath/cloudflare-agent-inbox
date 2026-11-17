import type { Db } from "./db.ts";
import { generateShareToken, sha256Hex } from "./tokens.ts";

export const DEFAULT_SHARE_TTL_MINUTES = 15;
export const MAX_SHARE_TTL_MINUTES = 60;

export function clampTtlMinutes(requested: number | undefined): number {
  const ttl = requested ?? DEFAULT_SHARE_TTL_MINUTES;
  return Math.max(1, Math.min(Math.floor(ttl), MAX_SHARE_TTL_MINUTES));
}

export async function createShare(
  db: Db,
  attachmentId: string,
  agentId: string,
  ttlMinutes: number,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: string }> {
  const token = generateShareToken();
  const expiresAt = new Date(now.getTime() + clampTtlMinutes(ttlMinutes) * 60_000).toISOString();
  await db.run("INSERT INTO shares (token_hash, attachment_id, agent_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)", [
    await sha256Hex(token),
    attachmentId,
    agentId,
    expiresAt,
    now.toISOString(),
  ]);
  return { token, expiresAt };
}

export interface ResolvedShare {
  attachment_id: string;
  agent_id: string;
  r2_key: string;
  filename: string;
  content_type: string;
}

/**
 * Resolves an unexpired link to its file. A link only works while everything that
 * allowed it still holds: the message exists, the lane is still shareable, the agent
 * that made it is not revoked and still has the lane granted.
 */
export async function resolveShare(db: Db, token: string, now: Date = new Date()): Promise<ResolvedShare | null> {
  return db.first<ResolvedShare>(
    `SELECT a.id AS attachment_id, s.agent_id, a.r2_key, a.filename, a.content_type
       FROM shares s
       JOIN attachments a ON a.id = s.attachment_id
       JOIN messages m ON m.id = a.message_id
       JOIN lanes l ON l.id = m.lane_id
       JOIN agents ag ON ag.id = s.agent_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND m.deleted_at IS NULL
        AND l.shareable = 1 AND ag.revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM agent_lanes al WHERE al.agent_id = s.agent_id AND al.lane_id = m.lane_id)`,
    [await sha256Hex(token), now.toISOString()],
  );
}
