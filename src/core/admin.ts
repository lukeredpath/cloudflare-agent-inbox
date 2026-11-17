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
  filename: string;
  transform_error: string;
}

export async function listTransformFailures(db: Db, laneId: string, limit = 20): Promise<TransformFailure[]> {
  return db.all<TransformFailure>(
    `SELECT a.message_id, a.id AS attachment_id, a.filename, a.transform_error
       FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE m.lane_id = ? AND m.deleted_at IS NULL AND a.transform_error IS NOT NULL
      ORDER BY m.received_at DESC LIMIT ?`,
    [laneId, limit],
  );
}
