import { beforeEach, describe, expect, it } from "vitest";
import {
  createAgent,
  findAgentByTokenHash,
  grantLane,
  listAgents,
  revokeAgent,
  ungrantLane,
} from "../src/core/agents";
import type { Db } from "../src/core/db";
import { sha256Hex } from "../src/core/encoding";
import {
  CoreError,
  createLane,
  deleteLane,
  getLaneBySlug,
  getLaneByToken,
  listLanes,
  rotateLaneToken,
  setLaneStatus,
  updateLane,
} from "../src/core/lanes";
import {
  deleteMessage,
  getAttachmentForAgent,
  getMessageForAgent,
  insertMessage,
  listAttachments,
  listMessagesAdmin,
  listMessagesForAgent,
  markProcessed,
  markUnprocessed,
  setKeep,
  type NewMessage,
} from "../src/core/messages";
import { listRejections, logRejection, purgeRejections } from "../src/core/rejections";
import { clampTtlMinutes, createShare, resolveShare } from "../src/core/shares";
import { freshDb } from "./helpers/db";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const message = (laneId: string, id: string, extra: Partial<NewMessage> = {}): NewMessage => ({
  id,
  laneId,
  receivedAt: new Date().toISOString(),
  envelopeFrom: "sender@example.com",
  headerFrom: "sender@example.com",
  originalFrom: null,
  subject: "Hello",
  size: 100,
  authSummary: "dkim=pass",
  cleanText: "body",
  rawKey: `raw/${id}`,
  isTest: false,
  ...extra,
});

describe("lanes", () => {
  it("creates, finds by token and by slug, and lists with counts", async () => {
    const lane = await createLane(db, { slug: "receipts", description: "Receipts" });
    expect(lane.status).toBe("active");
    expect(lane.addressToken).toMatch(/^[a-z2-7]{32}$/);
    expect((await getLaneByToken(db, lane.addressToken))?.id).toBe(lane.id);
    expect((await getLaneBySlug(db, "receipts"))?.id).toBe(lane.id);
    expect(await getLaneByToken(db, "nope")).toBeNull();
    const [summary] = await listLanes(db);
    expect(summary).toMatchObject({ slug: "receipts", messageCount: 0, unprocessedCount: 0, lastReceivedAt: null });
  });

  it("refuses a duplicate slug", async () => {
    await createLane(db, { slug: "dup" });
    await expect(createLane(db, { slug: "dup" })).rejects.toThrow(CoreError);
  });

  it("updates settings without changing the address", async () => {
    const lane = await createLane(db, { slug: "a" });
    const updated = await updateLane(db, lane.id, { shareable: true, retention_days: 30, description: "new" });
    expect(updated).toMatchObject({ shareable: true, retentionDays: 30, description: "new", addressToken: lane.addressToken });
    await expect(updateLane(db, lane.id, {})).rejects.toThrow("Nothing to update");
    await expect(updateLane(db, lane.id, { slug: "renamed" })).rejects.toThrow();
  });

  it("pauses, resumes and rotates", async () => {
    const lane = await createLane(db, { slug: "a" });
    await setLaneStatus(db, lane.id, "paused");
    expect((await getLaneBySlug(db, "a"))?.status).toBe("paused");
    await setLaneStatus(db, lane.id, "active");
    const rotated = await rotateLaneToken(db, lane.id);
    expect(rotated.addressToken).not.toBe(lane.addressToken);
    expect(await getLaneByToken(db, lane.addressToken)).toBeNull();
  });

  it("delete removes the lane and grants, soft-deletes messages, and keeps rejections", async () => {
    const lane = await createLane(db, { slug: "gone" });
    const { agent } = await createAgent(db, "bot");
    await grantLane(db, agent.id, lane.id);
    await insertMessage(db, message(lane.id, "m1"), []);
    await logRejection(db, { bucket: "lane", recipientHint: "inbox+ab…", envelopeFrom: "x@example.com", headerFrom: null, reason: "auth_failed", laneId: lane.id }, 50);
    await deleteLane(db, lane.id);
    expect(await getLaneBySlug(db, "gone")).toBeNull();
    expect(await db.all("SELECT * FROM agent_lanes")).toHaveLength(0);
    expect((await db.first<{ deleted_at: string | null }>("SELECT deleted_at FROM messages WHERE id = 'm1'"))?.deleted_at).toBeTruthy();
    expect(await listRejections(db)).toHaveLength(1);
    await expect(deleteLane(db, lane.id)).rejects.toThrow("not found");
  });
});

describe("agents", () => {
  it("stores only a hash and finds the agent by it", async () => {
    const { agent, token } = await createAgent(db, "agent-one");
    const stored = await db.first<{ token_hash: string }>("SELECT token_hash FROM agents WHERE id = ?", [agent.id]);
    expect(stored?.token_hash).toBe(await sha256Hex(token));
    expect(JSON.stringify(await db.all("SELECT * FROM agents"))).not.toContain(token);
    expect((await findAgentByTokenHash(db, await sha256Hex(token)))?.id).toBe(agent.id);
  });

  it("revocation takes effect immediately", async () => {
    const { agent, token } = await createAgent(db, "bot");
    await revokeAgent(db, agent.id);
    expect(await findAgentByTokenHash(db, await sha256Hex(token))).toBeNull();
    await expect(revokeAgent(db, agent.id)).rejects.toThrow(CoreError);
  });

  it("lists grants and supports ungrant", async () => {
    const lane = await createLane(db, { slug: "a" });
    const { agent } = await createAgent(db, "bot");
    await grantLane(db, agent.id, lane.id);
    await grantLane(db, agent.id, lane.id);
    expect((await listAgents(db))[0]?.lanes).toEqual(["a"]);
    await ungrantLane(db, agent.id, lane.id);
    expect((await listAgents(db))[0]?.lanes).toEqual([]);
  });

  it("rejects bad names and duplicates", async () => {
    await expect(createAgent(db, "has space")).rejects.toThrow(CoreError);
    await createAgent(db, "bot");
    await expect(createAgent(db, "bot")).rejects.toThrow("already exists");
  });
});

describe("messages and agent scoping", () => {
  async function setup() {
    const a = await createLane(db, { slug: "lane-a", shareable: true });
    const b = await createLane(db, { slug: "lane-b" });
    const { agent } = await createAgent(db, "bot");
    await grantLane(db, agent.id, a.id);
    await insertMessage(db, message(a.id, "ma"), [
      { id: "att-a", parentId: null, filename: "a.pdf", contentType: "application/pdf", size: 5, r2Key: "k/a", transformError: null },
    ]);
    await insertMessage(db, message(b.id, "mb"), [
      { id: "att-b", parentId: null, filename: "b.pdf", contentType: "application/pdf", size: 5, r2Key: "k/b", transformError: null },
    ]);
    return { a, b, agent };
  }

  it("an agent sees only granted lanes, in every query", async () => {
    const { agent } = await setup();
    expect((await listMessagesForAgent(db, agent.id)).map((m) => m.id)).toEqual(["ma"]);
    expect(await getMessageForAgent(db, agent.id, "ma")).not.toBeNull();
    expect(await getMessageForAgent(db, agent.id, "mb")).toBeNull();
    expect(await getAttachmentForAgent(db, agent.id, "att-a")).not.toBeNull();
    expect(await getAttachmentForAgent(db, agent.id, "att-b")).toBeNull();
    expect(await markProcessed(db, agent.id, "bot", "mb", null)).toBe(false);
    expect(await listMessagesForAgent(db, agent.id, { laneSlug: "lane-b" })).toEqual([]);
  });

  it("marks processed with the agent name, and hides processed by default", async () => {
    const { agent } = await setup();
    expect(await markProcessed(db, agent.id, "bot", "ma", "done")).toBe(true);
    expect(await listMessagesForAgent(db, agent.id)).toEqual([]);
    const [m] = await listMessagesForAgent(db, agent.id, { unprocessedOnly: false });
    expect(m).toMatchObject({ processed_by: "bot", processed_note: "done" });
    expect(await markUnprocessed(db, "ma")).toBe(true);
    expect(await listMessagesForAgent(db, agent.id)).toHaveLength(1);
  });

  it("soft-deleted messages vanish from agent and admin views", async () => {
    const { agent } = await setup();
    expect(await deleteMessage(db, "ma")).toBe(true);
    expect(await listMessagesForAgent(db, agent.id)).toEqual([]);
    expect((await listMessagesAdmin(db)).map((m) => m.id)).toEqual(["mb"]);
    expect(await getAttachmentForAgent(db, agent.id, "att-a")).toBeNull();
    expect(await deleteMessage(db, "ma")).toBe(false);
  });

  it("insert is atomic: a failing attachment leaves no message behind", async () => {
    const lane = await createLane(db, { slug: "x" });
    const dup = { id: "same", parentId: null, filename: "f", contentType: "text/plain", size: 1, r2Key: "k", transformError: null };
    await expect(insertMessage(db, message(lane.id, "atomic"), [dup, dup])).rejects.toThrow();
    expect(await db.all("SELECT id FROM messages WHERE id = 'atomic'")).toHaveLength(0);
  });

  it("tracks keep and attachment counts", async () => {
    const { a } = await setup();
    expect(await setKeep(db, "ma", true)).toBe(true);
    const rows = await listMessagesAdmin(db, { laneId: a.id });
    expect(rows[0]).toMatchObject({ keep: 1, attachment_count: 1, transform_error_count: 0 });
    expect(await listAttachments(db, "ma")).toHaveLength(1);
  });
});

describe("shares", () => {
  it("clamps the lifetime to 1-60 minutes, default 15", () => {
    expect(clampTtlMinutes(undefined)).toBe(15);
    expect(clampTtlMinutes(0)).toBe(1);
    expect(clampTtlMinutes(500)).toBe(60);
  });

  it("resolves until expiry, stores only a hash, and dies with the message", async () => {
    const lane = await createLane(db, { slug: "s", shareable: true });
    await insertMessage(db, message(lane.id, "m"), [
      { id: "att", parentId: null, filename: "f.pdf", contentType: "application/pdf", size: 1, r2Key: "k", transformError: null },
    ]);
    const now = new Date("2026-01-01T00:00:00Z");
    const { token, expiresAt } = await createShare(db, "att", "agent-1", 10, now);
    expect(expiresAt).toBe("2026-01-01T00:10:00.000Z");
    expect(JSON.stringify(await db.all("SELECT * FROM shares"))).not.toContain(token);
    expect(await resolveShare(db, token, new Date("2026-01-01T00:09:59Z"))).toMatchObject({ r2_key: "k" });
    expect(await resolveShare(db, token, new Date("2026-01-01T00:10:01Z"))).toBeNull();
    expect(await resolveShare(db, "wrong", now)).toBeNull();
    await deleteMessage(db, "m");
    expect(await resolveShare(db, token, now)).toBeNull();
  });
});

describe("rejections", () => {
  const rej = (bucket: "probe" | "lane") => ({
    bucket,
    recipientHint: "inbox+ab…",
    envelopeFrom: "x@example.com",
    headerFrom: null,
    reason: "sender_not_allowed" as const,
  });

  it("caps each bucket separately", async () => {
    expect(await logRejection(db, rej("probe"), 2)).toBe(true);
    expect(await logRejection(db, rej("probe"), 2)).toBe(true);
    expect(await logRejection(db, rej("probe"), 2)).toBe(false);
    expect(await logRejection(db, rej("lane"), 2)).toBe(true);
    expect(await listRejections(db)).toHaveLength(3);
  });

  it("the cap is a rolling day and old rows are purged after 30 days", async () => {
    const old = new Date(Date.now() - 31 * 86_400_000);
    await logRejection(db, rej("lane"), 1, old);
    expect(await logRejection(db, rej("lane"), 1)).toBe(true);
    expect(await purgeRejections(db)).toBe(1);
    expect(await listRejections(db)).toHaveLength(1);
  });
});
