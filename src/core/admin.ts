import type { Db } from "./db.ts";

export interface ActiveShare {
  agent: string | null;
  attachment_filename: string;
  expires_at: string;
  created_at: string;
}

/** Unexpired share links on a lane: who made them and when they expire. Never the links themselves. */
export async function listActiveShares(db: Db, laneId: string, now: Date = new Date()): Promise<ActiveShare[]> {
  return db.all<ActiveShare>(
    `SELECT ag.name AS agent, a.filename AS attachment_filename, s.expires_at, s.created_at
       FROM shares s
       JOIN attachments a ON a.id = s.attachment_id
       JOIN messages m ON m.id = a.message_id
       LEFT JOIN agents ag ON ag.id = s.agent_id
      WHERE m.lane_id = ? AND m.deleted_at IS NULL AND s.expires_at > ?
      ORDER BY s.created_at DESC LIMIT 50`,
    [laneId, now.toISOString()],
  );
}

export interface TransformFailure {
  message_id: string;
  attachment_id: string;
  received_at: string;
  filename: string;
  transform_error: string;
}

export async function listTransformFailures(db: Db, laneId: string, limit = 20): Promise<TransformFailure[]> {
  return db.all<TransformFailure>(
    `SELECT a.message_id, a.id AS attachment_id, m.received_at, a.filename, a.transform_error
       FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE m.lane_id = ? AND m.deleted_at IS NULL AND a.transform_error IS NOT NULL
      ORDER BY m.received_at DESC LIMIT ?`,
    [laneId, limit],
  );
}

/** Agents with a live token that can read each lane, by lane id. */
export async function laneAgentCounts(db: Db): Promise<Map<string, number>> {
  const rows = await db.all<{ lane_id: string; n: number }>(
    `SELECT al.lane_id, COUNT(*) AS n FROM agent_lanes al JOIN agents a ON a.id = al.agent_id
      WHERE a.revoked_at IS NULL GROUP BY al.lane_id`,
  );
  return new Map(rows.map((r) => [r.lane_id, r.n]));
}

/** Attachments whose transform failed, per lane, on messages that still exist. */
export async function transformFailureCounts(db: Db): Promise<{ slug: string; count: number }[]> {
  return db.all<{ slug: string; count: number }>(
    `SELECT l.slug, COUNT(*) AS count
       FROM attachments a JOIN messages m ON m.id = a.message_id JOIN lanes l ON l.id = m.lane_id
      WHERE m.deleted_at IS NULL AND a.transform_error IS NOT NULL
      GROUP BY l.slug ORDER BY l.slug`,
  );
}

export async function rejectionCountsSince(db: Db, since: Date): Promise<{ probe: number; lane: number }> {
  const rows = await db.all<{ bucket: string; n: number }>(
    "SELECT bucket, COUNT(*) AS n FROM rejections WHERE received_at > ? GROUP BY bucket",
    [since.toISOString()],
  );
  const count = (bucket: string) => rows.find((r) => r.bucket === bucket)?.n ?? 0;
  return { probe: count("probe"), lane: count("lane") };
}
