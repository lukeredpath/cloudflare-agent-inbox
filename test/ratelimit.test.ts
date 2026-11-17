import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/core/db";
import { createLane, type Lane } from "../src/core/lanes";
import { handleEmail } from "../src/worker/email";
import { AUTH_PASS, buildEml } from "./helpers/eml";
import { freshDb } from "./helpers/db";
import { laneAddress, makeMessage, testEnv } from "./helpers/mail";

let db: Db;
let lane: Lane;
let lines: Record<string, unknown>[];

beforeEach(async () => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    try {
      lines.push(JSON.parse(String(a[0])));
    } catch {
      /* not ours */
    }
  });
  db = await freshDb();
  lane = await createLane(db, { slug: "receipts" });
  const bucket = testEnv().BUCKET;
  const listed = await bucket.list();
  if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
});
afterEach(() => vi.restoreAllMocks());

const limiter = (outcome: "deny" | "allow" | "throw") => {
  const calls: { key: string }[] = [];
  return {
    calls,
    binding: {
      limit: async (o: { key: string }) => {
        calls.push(o);
        if (outcome === "throw") throw new Error("limiter down");
        return { success: outcome === "allow" };
      },
    },
  };
};

async function deliver(opts: { from?: string; env?: Record<string, unknown> } = {}) {
  const from = opts.from ?? "sender@example.com";
  const raw = buildEml({ from, auth: [AUTH_PASS("example.com", from)] });
  const message = makeMessage(raw, { to: laneAddress(lane), from });
  await handleEmail(message, testEnv(opts.env));
  return message;
}
const count = async (table: string) => (await db.all(`SELECT 1 FROM ${table}`)).length;

describe("mail rate limit for unlisted senders", () => {
  it("drops mail from an unlisted sender once the limit is hit, before any database work", async () => {
    const l = limiter("deny");
    const noDb = { prepare: () => { throw new Error("the database must not be touched"); }, batch: () => { throw new Error("no"); } } as unknown as D1Database;
    const message = await deliver({ from: "stranger@example.org", env: { MAIL_LIMITER: l.binding, DB: noDb } });
    expect(message.rejected).toBeNull();
    expect(l.calls).toEqual([{ key: "unlisted-sender" }]);
    expect(lines.find((x) => x.event === "email")).toMatchObject({ outcome: "rejected", reason: "rate_limited" });
    expect(await count("rejections")).toBe(0);
  });

  it("never limits a listed sender, even if the limiter would deny", async () => {
    const l = limiter("deny");
    await deliver({ env: { MAIL_LIMITER: l.binding } });
    expect(l.calls).toEqual([]);
    expect(await count("messages")).toBe(1);
  });

  it("lets an unlisted sender through while under the limit, and the normal checks still apply", async () => {
    const l = limiter("allow");
    await deliver({ from: "stranger@example.org", env: { MAIL_LIMITER: l.binding } });
    expect(l.calls).toHaveLength(1);
    expect((await db.all<{ reason: string }>("SELECT reason FROM rejections"))[0]?.reason).toBe("sender_not_allowed");
    expect(await count("messages")).toBe(0);
  });

  it("fails open if the limiter itself errors, so real mail is never lost to it", async () => {
    const l = limiter("throw");
    // A lane-specific sender is unlisted at deployment level but genuine.
    const own = await createLane(db, { slug: "own", allowed_senders: ["lane-only@example.com"] });
    const raw = buildEml({ from: "lane-only@example.com", auth: [AUTH_PASS("example.com", "lane-only@example.com")] });
    const message = makeMessage(raw, { to: laneAddress(own), from: "lane-only@example.com" });
    await handleEmail(message, testEnv({ MAIL_LIMITER: l.binding }));
    expect(await count("messages")).toBe(1);
  });

  it("does nothing when the binding is absent", async () => {
    await deliver({ from: "stranger@example.org" });
    expect((await db.all<{ reason: string }>("SELECT reason FROM rejections"))[0]?.reason).toBe("sender_not_allowed");
  });

  it("keys on one constant, never on an address", async () => {
    const l = limiter("allow");
    await deliver({ from: "stranger@example.org", env: { MAIL_LIMITER: l.binding } });
    await deliver({ from: "another@example.net", env: { MAIL_LIMITER: l.binding } });
    expect(new Set(l.calls.map((c) => c.key))).toEqual(new Set(["unlisted-sender"]));
  });
});
