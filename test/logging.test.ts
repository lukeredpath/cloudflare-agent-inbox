import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/core/db";
import { createLane, setLaneStatus, type Lane } from "../src/core/lanes";
import { insertMessage } from "../src/core/messages";
import { createShare } from "../src/core/shares";
import { handleEmail } from "../src/worker/email";
import { purge } from "../src/worker/purge";
import { AUTH_NONE, buildEml, type EmlOptions } from "./helpers/eml";
import { freshDb } from "./helpers/db";
import { MAIL_HOST, laneAddress, makeMessage, testEnv, workerFetch } from "./helpers/mail";
import { agentWith, callTool } from "./helpers/mcp";

type Line = Record<string, unknown> & { event: string; _level: string };
let lines: Line[];
let db: Db;
let lane: Lane;

beforeEach(async () => {
  lines = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      try {
        lines.push({ ...JSON.parse(String(args[0])), _level: level });
      } catch {
        /* not one of ours */
      }
    });
  }
  db = await freshDb();
  lane = await createLane(db, { slug: "receipts" });
  const bucket = testEnv().BUCKET;
  const listed = await bucket.list();
  if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
});
afterEach(() => vi.restoreAllMocks());

const events = (name: string) => lines.filter((l) => l.event === name);
const SECRET_SUBJECT = "Quarterly secret subject";
const SECRET_BODY = "SECRET-BODY-CONTENT";

async function deliver(o: EmlOptions = {}, opts: { to?: string; env?: Record<string, unknown>; from?: string } = {}) {
  const message = makeMessage(buildEml({ subject: SECRET_SUBJECT, text: SECRET_BODY, ...o }), { to: opts.to ?? laneAddress(lane), from: opts.from });
  await handleEmail(message, testEnv(opts.env));
  return message;
}

describe("email outcome logging", () => {
  it("logs one line for an accepted message, with the lane, path, size and timing", async () => {
    await deliver();
    expect(events("email")).toHaveLength(1);
    expect(events("email")[0]).toMatchObject({ outcome: "accepted", lane: lane.id, path: "direct", files: 0, _level: "log" });
    expect(typeof events("email")[0]!.bytes).toBe("number");
    expect(typeof events("email")[0]!.ms).toBe("number");
  });

  it("logs the reason for every kind of rejection, with the lane when there is one", async () => {
    await deliver({}, { to: `inbox+${"a".repeat(32)}@${MAIL_HOST}` });
    await deliver({}, { from: "attacker@example.org" });
    await deliver({ auth: [AUTH_NONE] });
    await setLaneStatus(db, lane.id, "paused");
    await deliver();
    const tiny = await createLane(db, { slug: "tiny", max_bytes: 2048 });
    await deliver({ text: "x".repeat(5000) }, { to: laneAddress(tiny) });
    expect(events("email").map((l) => [l.outcome, l.reason, l.lane])).toEqual([
      ["rejected", "unknown_address", null],
      ["rejected", "sender_not_allowed", lane.id],
      ["rejected", "auth_failed", lane.id],
      ["rejected", "lane_paused", lane.id],
      ["rejected", "too_large", tiny.id],
    ]);
  });

  it("logs an error, at error level, when a verified message cannot be stored, and tells the sender to resend", async () => {
    const brokenDb = { prepare: (sql: string) => testEnv().DB.prepare(sql), batch: () => Promise.reject(new Error("d1 down")) } as unknown as D1Database;
    const message = await deliver({}, { env: { DB: brokenDb } });
    expect(events("email")[0]).toMatchObject({ outcome: "error", authenticated: true, lane: lane.id, _level: "error" });
    expect(message.rejected).toMatch(/send it again/i);
    expect(message.rejected).not.toMatch(/temporary/i);
  });

  it("never logs addresses, subjects, bodies or the lane's address token", async () => {
    await deliver();
    await deliver({ auth: [AUTH_NONE] });
    await deliver({}, { from: "attacker@example.org" });
    await deliver({}, { to: `inbox+${lane.addressToken}x@${MAIL_HOST}` });
    const dump = JSON.stringify(lines);
    for (const forbidden of ["sender@example.com", "attacker@example.org", SECRET_SUBJECT, SECRET_BODY, lane.addressToken, MAIL_HOST, "example.com"]) {
      expect(dump, forbidden).not.toContain(forbidden);
    }
  });
});

describe("share and MCP logging", () => {
  it("logs who used a share link and which file, never the link", async () => {
    const shareLane = await createLane(db, { slug: "files", shareable: true });
    await insertMessage(
      db,
      { id: "m1", laneId: shareLane.id, receivedAt: new Date().toISOString(), envelopeFrom: "s@example.com", headerFrom: null, originalFrom: null, subject: null, size: 1, authSummary: null, cleanText: "", rawKey: "raw/m1", isTest: false },
      [{ id: "att1", parentId: null, filename: "f.pdf", contentType: "application/pdf", size: 3, r2Key: "k/att1", transformError: null }],
    );
    await testEnv().BUCKET.put("k/att1", "PDF");
    const agent = await agentWith(db, "sharer", [shareLane]);
    const { data } = await callTool(agent.token, "create_share_link", { attachment_id: "att1" });
    lines.length = 0;

    await workerFetch(data.url);
    await workerFetch(`https://files.example.com/s/${"a".repeat(39)}`);
    const shares = events("share");
    expect(shares[0]).toMatchObject({ outcome: "served", attachment: "att1", agent: agent.id, bytes: 3 });
    expect(shares[1]).toMatchObject({ outcome: "not_found" });
    expect(JSON.stringify(lines)).not.toContain(data.url.split("/s/")[1]);
  });

  it("logs each tool call with the agent id and outcome, and nothing from the request", async () => {
    const agent = await agentWith(db, "reader", [lane]);
    await callTool(agent.token, "list_messages");
    await callTool(agent.token, "get_message", { id: "nope" });
    expect(events("mcp").map((l) => [l.tool, l.outcome, l.agent])).toEqual([
      ["list_messages", "ok", agent.id],
      ["get_message", "refused", agent.id],
    ]);
  });
});

describe("purge logging and isolation", () => {
  it("logs a summary of what it did", async () => {
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    await insertMessage(db, { id: "old", laneId: lane.id, receivedAt: old, envelopeFrom: "s@example.com", headerFrom: null, originalFrom: null, subject: null, size: 1, authSummary: null, cleanText: "", rawKey: "raw/old", isTest: false }, []);
    await testEnv().BUCKET.put("raw/old", "x");
    await purge(testEnv());
    expect(events("purge")[0]).toMatchObject({ expired_messages: 1, removed_messages: 1, failed_steps: [] });
  });

  it("a failing step does not stop the others, is logged by name, and fails the run", async () => {
    await insertMessage(db, { id: "gone", laneId: lane.id, receivedAt: new Date().toISOString(), envelopeFrom: "s@example.com", headerFrom: null, originalFrom: null, subject: null, size: 1, authSummary: null, cleanText: "", rawKey: "raw/gone", isTest: false }, []);
    await db.run("UPDATE messages SET deleted_at = ?", [new Date().toISOString()]);
    // An old rejection that the last step should still remove.
    await db.run(
      "INSERT INTO rejections (id, received_at, bucket, recipient_hint, envelope_from, reason) VALUES ('r', ?, 'lane', 'x', 'a@example.com', 'auth_failed')",
      [new Date(Date.now() - 40 * 86_400_000).toISOString()],
    );
    const failingBucket = { delete: () => Promise.reject(new Error("r2 down")) };
    await expect(purge(testEnv({ BUCKET: failingBucket }))).rejects.toThrow("Purge steps failed: messages");

    expect(events("purge_step_failed")).toEqual([expect.objectContaining({ step: "messages", error: "Error", _level: "error" })]);
    expect(events("purge")[0]).toMatchObject({ failed_steps: ["messages"], removed_rejections: 1 });
    expect(await db.all("SELECT id FROM rejections")).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain("r2 down");
  });
});
