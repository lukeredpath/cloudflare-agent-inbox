import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/core/db";
import { createLane, deleteLane } from "../src/core/lanes";
import { insertMessage } from "../src/core/messages";
import { logRejection } from "../src/core/rejections";
import { createShare } from "../src/core/shares";
import { purge } from "../src/worker/purge";
import { freshDb } from "./helpers/db";
import { testEnv } from "./helpers/mail";

const env = testEnv();
let db: Db;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const message = (laneId: string, id: string, receivedAt: string) => ({
  id, laneId, receivedAt, envelopeFrom: "s@example.com", headerFrom: null, originalFrom: null, subject: null,
  size: 1, authSummary: null, cleanText: "", rawKey: `raw/${id}`, isTest: false,
});
const attachment = (id: string) => ({ id, parentId: null, filename: "f.pdf", contentType: "application/pdf", size: 1, r2Key: `att/${id}`, transformError: null });
const ids = async () => (await db.all<{ id: string }>("SELECT id FROM messages")).map((r) => r.id).sort();

async function put(...keys: string[]) {
  for (const k of keys) await env.BUCKET.put(k, "x");
}
const keys = async () => (await env.BUCKET.list()).objects.map((o) => o.key).sort();

beforeEach(async () => {
  db = await freshDb();
  const listed = await env.BUCKET.list();
  if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((o) => o.key));
});

describe("scheduled purge", () => {
  it("removes messages past their own lane's retention, from D1 and R2, and respects keep", async () => {
    const short = await createLane(db, { slug: "short", retention_days: 30 });
    const long = await createLane(db, { slug: "long", retention_days: 90 });
    await insertMessage(db, message(short.id, "short-old", daysAgo(40)), [attachment("att-short-old")]);
    await insertMessage(db, message(short.id, "short-new", daysAgo(10)), []);
    await insertMessage(db, message(long.id, "long-40", daysAgo(40)), []);
    await insertMessage(db, message(long.id, "long-100", daysAgo(100)), []);
    await insertMessage(db, message(short.id, "short-kept", daysAgo(200)), []);
    await db.run("UPDATE messages SET keep = 1 WHERE id = 'short-kept'");
    await put("raw/short-old", "att/att-short-old", "raw/long-100", "raw/long-40", "raw/short-kept");

    const result = await purge(env);
    expect(result.removed).toBe(2);
    expect(await ids()).toEqual(["long-40", "short-kept", "short-new"]);
    expect(await keys()).toEqual(["raw/long-40", "raw/short-kept"]);
    expect(await db.all("SELECT * FROM attachments")).toHaveLength(0);
  });

  it("removes expired share links and keeps live ones", async () => {
    const lane = await createLane(db, { slug: "s", shareable: true });
    await insertMessage(db, message(lane.id, "m", daysAgo(1)), [attachment("a")]);
    await createShare(db, "a", "agent", 10, new Date(Date.now() - 3 * 3_600_000));
    await createShare(db, "a", "agent", 10);
    await purge(env);
    expect(await db.all("SELECT * FROM shares")).toHaveLength(1);
  });

  it("finishes the job for a deleted lane and a deleted message, including their share links", async () => {
    const gone = await createLane(db, { slug: "gone" });
    const stays = await createLane(db, { slug: "stays" });
    await insertMessage(db, message(gone.id, "g1", daysAgo(1)), [attachment("ga")]);
    await insertMessage(db, message(stays.id, "s1", daysAgo(1)), [attachment("sa")]);
    await insertMessage(db, message(stays.id, "s2", daysAgo(1)), [attachment("sb")]);
    await put("raw/g1", "att/ga", "raw/s1", "att/sa", "raw/s2", "att/sb");
    await createShare(db, "ga", "agent", 30);
    await deleteLane(db, gone.id);
    await db.run("UPDATE messages SET deleted_at = ? WHERE id = 's2'", [new Date().toISOString()]);

    await purge(env);
    expect(await ids()).toEqual(["s1"]);
    expect(await keys()).toEqual(["att/sa", "raw/s1"]);
    expect(await db.all("SELECT * FROM shares")).toHaveLength(0);
    expect((await db.all<{ id: string }>("SELECT id FROM attachments")).map((a) => a.id)).toEqual(["sa"]);
  });

  it("works through a backlog over several batches", async () => {
    const lane = await createLane(db, { slug: "bulk" });
    for (let i = 0; i < 25; i++) await insertMessage(db, message(lane.id, `m${i}`, daysAgo(1)), []);
    await db.run("UPDATE messages SET deleted_at = ?", [new Date().toISOString()]);
    expect((await purge(env)).removed).toBe(25);
    expect(await ids()).toEqual([]);
  });

  it("leaves rows in place when R2 deletion fails, so the next run retries", async () => {
    const lane = await createLane(db, { slug: "retry" });
    await insertMessage(db, message(lane.id, "m", daysAgo(1)), []);
    await db.run("UPDATE messages SET deleted_at = ?", [new Date().toISOString()]);
    const failing = testEnv({ BUCKET: { delete: () => Promise.reject(new Error("r2 down")) } });
    await expect(purge(failing)).rejects.toThrow("r2 down");
    expect(await ids()).toEqual(["m"]);
    await purge(env);
    expect(await ids()).toEqual([]);
  });

  it("purges rejections older than 30 days", async () => {
    const rej = { bucket: "lane" as const, recipientHint: "x", envelopeFrom: "a@example.com", headerFrom: null, reason: "auth_failed" as const };
    await logRejection(db, rej, 50, new Date(Date.now() - 40 * 86_400_000));
    await logRejection(db, rej, 50);
    await purge(env);
    expect(await db.all("SELECT * FROM rejections")).toHaveLength(1);
  });

  it("does nothing on an empty database", async () => {
    expect(await purge(env)).toEqual({ removed: 0 });
  });
});
