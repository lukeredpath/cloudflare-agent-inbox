import { d1Db, type Db } from "../core/db.ts";
import { purgeRejections } from "../core/rejections.ts";
import type { Env } from "./env.ts";

/** Messages purged per batch, and batches per run, sized for the Free plan's 50-subrequest budget. */
const BATCH = 10;
const MAX_BATCHES = 5;

/**
 * Daily housekeeping: expired share links, messages past their lane's
 * retention, soft-deleted messages (with their R2 objects), and old rejections.
 */
export async function purge(env: Env, now: Date = new Date()): Promise<{ removed: number }> {
  const db = d1Db(env.DB);
  const iso = now.toISOString();

  await db.run("DELETE FROM shares WHERE expires_at < ?", [iso]);

  // Retention is per lane. `keep` exempts a message. Timestamps are ISO-8601, so they compare as text.
  await db.run(
    `UPDATE messages SET deleted_at = ?1
      WHERE deleted_at IS NULL AND keep = 0
        AND received_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?1, '-' || (SELECT retention_days FROM lanes l WHERE l.id = messages.lane_id) || ' days')`,
    [iso],
  );

  let removed = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await removeDeleted(env, db);
    removed += n;
    if (n < BATCH) break;
  }

  await purgeRejections(db, now);
  return { removed };
}

async function removeDeleted(env: Env, db: Db): Promise<number> {
  const messages = await db.all<{ id: string; raw_key: string | null }>(
    "SELECT id, raw_key FROM messages WHERE deleted_at IS NOT NULL LIMIT ?",
    [BATCH],
  );
  if (messages.length === 0) return 0;
  const marks = messages.map(() => "?").join(",");
  const ids = messages.map((m) => m.id);
  const attachments = await db.all<{ id: string; r2_key: string }>(`SELECT id, r2_key FROM attachments WHERE message_id IN (${marks})`, ids);

  const keys = [...messages.flatMap((m) => (m.raw_key ? [m.raw_key] : [])), ...attachments.map((a) => a.r2_key)];
  // Objects go first: if this fails the rows stay, and the next run tries again.
  if (keys.length > 0) await env.BUCKET.delete(keys);

  const attachmentMarks = attachments.map(() => "?").join(",");
  await db.batch([
    ...(attachments.length
      ? [{ sql: `DELETE FROM shares WHERE attachment_id IN (${attachmentMarks})`, params: attachments.map((a) => a.id) }]
      : []),
    { sql: `DELETE FROM attachments WHERE message_id IN (${marks})`, params: ids },
    { sql: `DELETE FROM messages WHERE id IN (${marks})`, params: ids },
  ]);
  return messages.length;
}
