import type { Db, Statement } from "./db.ts";

export interface NewMessage {
  id: string;
  laneId: string;
  receivedAt: string;
  envelopeFrom: string;
  headerFrom: string | null;
  originalFrom: string | null;
  subject: string | null;
  size: number;
  authSummary: string | null;
  cleanText: string;
  rawKey: string | null;
  isTest: boolean;
}

export interface NewAttachment {
  id: string;
  parentId: string | null;
  filename: string;
  contentType: string;
  size: number;
  r2Key: string;
  transformError: string | null;
}

/** Inserts a message and its attachments atomically. */
export async function insertMessage(db: Db, msg: NewMessage, attachments: NewAttachment[]): Promise<void> {
  const statements: Statement[] = [
    {
      sql: `INSERT INTO messages (id, lane_id, received_at, envelope_from, header_from, original_from, subject, size,
                                  auth_summary, clean_text, raw_key, is_test)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        msg.id,
        msg.laneId,
        msg.receivedAt,
        msg.envelopeFrom,
        msg.headerFrom,
        msg.originalFrom,
        msg.subject,
        msg.size,
        msg.authSummary,
        msg.cleanText,
        msg.rawKey,
        msg.isTest ? 1 : 0,
      ],
    },
    ...attachments.map((a) => ({
      sql: `INSERT INTO attachments (id, message_id, parent_id, filename, content_type, size, r2_key, transform_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [a.id, msg.id, a.parentId, a.filename, a.contentType, a.size, a.r2Key, a.transformError],
    })),
  ];
  await db.batch(statements);
}

export interface MessageRow {
  id: string;
  lane_id: string;
  lane_slug: string;
  received_at: string;
  envelope_from: string;
  header_from: string | null;
  original_from: string | null;
  subject: string | null;
  size: number;
  auth_summary: string | null;
  clean_text: string;
  is_test: number;
  keep: number;
  processed_at: string | null;
  processed_by: string | null;
  processed_note: string | null;
  attachment_count: number;
  transform_error_count: number;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  parent_id: string | null;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
  transform_error: string | null;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.lane_id, l.slug AS lane_slug, m.received_at, m.envelope_from, m.header_from, m.original_from,
         m.subject, m.size, m.auth_summary, m.clean_text, m.is_test, m.keep, m.processed_at, m.processed_by,
         m.processed_note,
         (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachment_count,
         (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id AND a.transform_error IS NOT NULL) AS transform_error_count
    FROM messages m JOIN lanes l ON l.id = m.lane_id`;

const clampLimit = (limit: number | undefined) => Math.max(1, Math.min(limit ?? 25, 100));

// ---- Agent side: every query is scoped to the agent's granted lanes in SQL.

const AGENT_SCOPE = "m.deleted_at IS NULL AND m.lane_id IN (SELECT lane_id FROM agent_lanes WHERE agent_id = ?)";

/** Whether the agent holds a grant on the lane. Says nothing about whether the lane exists otherwise. */
export async function agentHasLane(db: Db, agentId: string, laneSlug: string): Promise<boolean> {
  const row = await db.first<{ one: number }>(
    "SELECT 1 AS one FROM agent_lanes al JOIN lanes l ON l.id = al.lane_id WHERE al.agent_id = ? AND l.slug = ?",
    [agentId, laneSlug],
  );
  return row !== null;
}

export async function listMessagesForAgent(
  db: Db,
  agentId: string,
  opts: { laneSlug?: string; unprocessedOnly?: boolean; limit?: number } = {},
): Promise<MessageRow[]> {
  const where = [AGENT_SCOPE];
  const params: (string | number)[] = [agentId];
  if (opts.laneSlug) {
    where.push("l.slug = ?");
    params.push(opts.laneSlug);
  }
  if (opts.unprocessedOnly ?? true) where.push("m.processed_at IS NULL");
  params.push(clampLimit(opts.limit));
  return db.all<MessageRow>(`${MESSAGE_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.received_at DESC LIMIT ?`, params);
}

export async function getMessageForAgent(db: Db, agentId: string, id: string): Promise<MessageRow | null> {
  return db.first<MessageRow>(`${MESSAGE_SELECT} WHERE ${AGENT_SCOPE} AND m.id = ?`, [agentId, id]);
}

export async function listAttachments(db: Db, messageId: string): Promise<AttachmentRow[]> {
  return db.all<AttachmentRow>(
    "SELECT id, message_id, parent_id, filename, content_type, size, r2_key, transform_error FROM attachments WHERE message_id = ? ORDER BY rowid",
    [messageId],
  );
}

export interface AttachmentContext extends AttachmentRow {
  lane_id: string;
  lane_shareable: number;
}

export async function getAttachmentForAgent(db: Db, agentId: string, attachmentId: string): Promise<AttachmentContext | null> {
  return db.first<AttachmentContext>(
    `SELECT a.id, a.message_id, a.parent_id, a.filename, a.content_type, a.size, a.r2_key, a.transform_error,
            m.lane_id, l.shareable AS lane_shareable
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       JOIN lanes l ON l.id = m.lane_id
      WHERE ${AGENT_SCOPE} AND a.id = ?`,
    [agentId, attachmentId],
  );
}

export async function markProcessed(db: Db, agentId: string, agentName: string, id: string, note: string | null): Promise<boolean> {
  const { changes } = await db.run(
    `UPDATE messages SET processed_at = ?, processed_by = ?, processed_note = ?
      WHERE deleted_at IS NULL AND lane_id IN (SELECT lane_id FROM agent_lanes WHERE agent_id = ?) AND id = ?`,
    [new Date().toISOString(), agentName, note, agentId, id],
  );
  return changes > 0;
}

// ---- Admin side (CLI): not scoped to an agent.

export async function listMessagesAdmin(
  db: Db,
  opts: { laneId?: string; unprocessedOnly?: boolean; processedOnly?: boolean; limit?: number } = {},
): Promise<MessageRow[]> {
  const where = ["m.deleted_at IS NULL"];
  const params: (string | number)[] = [];
  if (opts.laneId) {
    where.push("m.lane_id = ?");
    params.push(opts.laneId);
  }
  if (opts.unprocessedOnly) where.push("m.processed_at IS NULL");
  if (opts.processedOnly) where.push("m.processed_at IS NOT NULL");
  params.push(clampLimit(opts.limit));
  return db.all<MessageRow>(`${MESSAGE_SELECT} WHERE ${where.join(" AND ")} ORDER BY m.received_at DESC LIMIT ?`, params);
}

export async function getMessageAdmin(db: Db, id: string): Promise<MessageRow | null> {
  return db.first<MessageRow>(`${MESSAGE_SELECT} WHERE m.deleted_at IS NULL AND m.id = ?`, [id]);
}

/** An attachment on a message that still exists, whichever lane it is in. */
export async function getAttachmentAdmin(db: Db, attachmentId: string): Promise<AttachmentRow | null> {
  return db.first<AttachmentRow>(
    `SELECT a.id, a.message_id, a.parent_id, a.filename, a.content_type, a.size, a.r2_key, a.transform_error
       FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE m.deleted_at IS NULL AND a.id = ?`,
    [attachmentId],
  );
}

export async function markUnprocessed(db: Db, id: string): Promise<boolean> {
  const { changes } = await db.run(
    "UPDATE messages SET processed_at = NULL, processed_by = NULL, processed_note = NULL WHERE id = ? AND deleted_at IS NULL",
    [id],
  );
  return changes > 0;
}

export async function setKeep(db: Db, id: string, keep: boolean): Promise<boolean> {
  const { changes } = await db.run("UPDATE messages SET keep = ? WHERE id = ? AND deleted_at IS NULL", [keep ? 1 : 0, id]);
  return changes > 0;
}

/** Soft delete: hidden everywhere at once; the hourly purge removes the rows and R2 objects. */
export async function deleteMessage(db: Db, id: string): Promise<boolean> {
  const { changes } = await db.run("UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", [
    new Date().toISOString(),
    id,
  ]);
  return changes > 0;
}
