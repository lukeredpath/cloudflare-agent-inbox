import { describe, expect, it } from "vitest";
import { buildAddress } from "../src/core/address";
import { createAgent, grantLane, revokeAgent } from "../src/core/agents";
import { d1Db, type Db } from "../src/core/db";
import { createLane, getLaneBySlug, getLaneByToken } from "../src/core/lanes";
import { insertMessage, markProcessed } from "../src/core/messages";
import { logRejection } from "../src/core/rejections";
import { createShare } from "../src/core/shares";
import { AGENT_TOKEN_PATTERN } from "../src/core/tokens";
import { ulid } from "../src/core/ulid";
import { useAdminApi } from "./helpers/admin";
import { testEnv } from "./helpers/mail";
import { freshDb } from "./helpers/db";

const api = useAdminApi();
const MAIL = "mail.example.com";

async function addMessage(db: Db, laneId: string, over: Record<string, unknown> = {}, attachments: Parameters<typeof insertMessage>[2] = []) {
  const id = ulid();
  await insertMessage(
    db,
    {
      id,
      laneId,
      receivedAt: new Date().toISOString(),
      envelopeFrom: "sender@example.com",
      headerFrom: "sender@example.com",
      originalFrom: null,
      subject: "Hello <b>there</b>",
      size: 1234,
      authSummary: "direct: dkim pass",
      cleanText: "The secret body text",
      rawKey: null,
      isTest: false,
      ...over,
    },
    attachments,
  );
  return id;
}

describe("lanes", () => {
  it("lists lanes with counts and live agent counts only", async () => {
    const db = await freshDb();
    const lane = await createLane(db, { slug: "bills", description: "Monthly bills" });
    await createLane(db, { slug: "other" });
    const live = await createAgent(db, "live");
    const gone = await createAgent(db, "gone");
    await grantLane(db, live.agent.id, lane.id);
    await grantLane(db, gone.agent.id, lane.id);
    await revokeAgent(db, gone.agent.id);
    const id = await addMessage(db, lane.id);
    await markProcessed(db, live.agent.id, "live", await addMessage(db, lane.id), null);

    const { status, body } = await api("GET", "/api/lanes");
    expect(status).toBe(200);
    expect(body).toEqual([
      { slug: "bills", description: "Monthly bills", status: "active", message_count: 2, unprocessed_count: 1, last_received_at: expect.any(String), agent_count: 1 },
      { slug: "other", description: "", status: "active", message_count: 0, unprocessed_count: 0, last_received_at: null, agent_count: 0 },
    ]);
    expect(id).toBeTruthy();
  });

  it("summarises what needs attention", async () => {
    const db = await freshDb();
    const lane = await createLane(db, { slug: "bills" });
    await addMessage(db, lane.id, {}, [
      { id: ulid(), parentId: null, filename: "a.zip", contentType: "application/zip", size: 1, r2Key: "k", transformError: "bad password" },
    ]);
    await logRejection(db, { bucket: "probe", recipientHint: "x", envelopeFrom: "a@example.com", headerFrom: null, reason: "unknown_address" }, 50);
    await logRejection(db, { bucket: "lane", recipientHint: "y", envelopeFrom: "b@example.com", headerFrom: null, reason: "lane_paused", laneId: lane.id }, 50);
    const { body } = await api("GET", "/api/overview");
    expect(body.transform_failures).toEqual([{ slug: "bills", count: 1 }]);
    expect(body.rejections_48h).toEqual({ probe: 1, lane: 1 });
    expect(body.lanes).toHaveLength(1);
  });

  it("creates a lane, returning the full address once and only a masked one in the lane", async () => {
    const { status, body } = await api("POST", "/api/lanes", { slug: "receipts", description: "Receipts", shareable: true });
    expect(status).toBe(201);
    const lane = (await getLaneBySlug(d1Db(testEnv().DB), "receipts"))!;
    expect(body.address).toBe(buildAddress(lane.addressToken, MAIL));
    expect(body.lane.address_masked).toContain("•");
    expect(JSON.stringify(body.lane)).not.toContain(lane.addressToken);
    expect(body.lane.shareable).toBe(true);
    expect(body.lane.allowed_senders).toBeNull();
  });

  it("explains validation failures field by field, and refuses duplicates", async () => {
    const bad = await api("POST", "/api/lanes", { slug: "Not Valid", forwarded_from: [{ from: "*@com", require: ["dkim"] }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid");
    expect(bad.body.issues.map((i: { path: string }) => i.path)).toContain("slug");
    await api("POST", "/api/lanes", { slug: "one" });
    const dup = await api("POST", "/api/lanes", { slug: "one" });
    expect(dup.status).toBe(409);
    expect((await api("POST", "/api/lanes", { slug: "x", surprise: true })).status).toBe(400);
  });

  it("rejects bodies that are not JSON or are too large", async () => {
    const res = await api("POST", "/api/lanes", "not an object" as unknown);
    expect(res.status).toBe(400);
    const huge = await api("POST", "/api/lanes", { slug: "x", description: "a".repeat(70_000) });
    expect(huge.status).toBe(413);
  });

  it("gives a lane's detail: grants, shares, failures, rejections and recent messages", async () => {
    const db = await freshDb();
    const lane = await createLane(db, { slug: "bills", shareable: true });
    const granted = await createAgent(db, "granted");
    await createAgent(db, "spare");
    const revoked = await createAgent(db, "revoked");
    await revokeAgent(db, revoked.agent.id);
    await grantLane(db, granted.agent.id, lane.id);
    const attachmentId = ulid();
    await addMessage(db, lane.id, {}, [{ id: attachmentId, parentId: null, filename: "a.pdf", contentType: "application/pdf", size: 1, r2Key: "k", transformError: "oops" }]);
    await createShare(db, attachmentId, granted.agent.id, 10);
    await logRejection(db, { bucket: "lane", recipientHint: "y", envelopeFrom: "b@example.com", headerFrom: null, reason: "too_large", detail: "big", laneId: lane.id }, 50);

    const { status, body } = await api("GET", "/api/lanes/bills");
    expect(status).toBe(200);
    expect(body.lane.slug).toBe("bills");
    expect(body.message_count).toBe(1);
    expect(body.agents).toEqual(["granted"]);
    expect(body.grantable_agents).toEqual(["spare"]);
    expect(body.shares).toEqual([{ agent: "granted", untrusted_filename: "a.pdf", expires_at: expect.any(String), created_at: expect.any(String) }]);
    expect(body.transform_failures[0]).toMatchObject({ untrusted_filename: "a.pdf", untrusted_error: "oops" });
    expect(body.rejections[0]).toMatchObject({ reason: "too_large", lane: "bills", untrusted_detail: "big" });
    expect(body.recent_messages).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(lane.addressToken);
    expect((await api("GET", "/api/lanes/missing")).status).toBe(404);
  });

  it("updates only the fields sent", async () => {
    const db = await freshDb();
    await createLane(db, { slug: "bills", description: "keep me", retention_days: 30 });
    const { status, body } = await api("PATCH", "/api/lanes/bills", { shareable: true, max_text_chars: 1000 });
    expect(status).toBe(200);
    expect(body).toMatchObject({ description: "keep me", retention_days: 30, shareable: true, max_text_chars: 1000 });
    expect((await api("PATCH", "/api/lanes/bills", {})).status).toBe(400);
    expect((await api("PATCH", "/api/lanes/bills", { slug: "renamed" })).status).toBe(400);
  });

  it("pauses and resumes", async () => {
    const db = await freshDb();
    await createLane(db, { slug: "bills" });
    expect((await api("PUT", "/api/lanes/bills/status", { status: "paused" })).status).toBe(200);
    expect((await getLaneBySlug(db, "bills"))!.status).toBe("paused");
    expect((await api("PUT", "/api/lanes/bills/status", { status: "active" })).status).toBe(200);
    expect((await api("PUT", "/api/lanes/bills/status", { status: "gone" })).status).toBe(400);
  });

  it("reveals the address on request and rotates it", async () => {
    const db = await freshDb();
    const lane = await createLane(db, { slug: "bills" });
    const shown = await api("GET", "/api/lanes/bills/address");
    expect(shown.body.address).toBe(buildAddress(lane.addressToken, MAIL));
    const rotated = await api("POST", "/api/lanes/bills/rotate");
    expect(rotated.status).toBe(200);
    expect(rotated.body.address).not.toBe(shown.body.address);
    expect(await getLaneByToken(db, lane.addressToken)).toBeNull();
  });

  it("deletes a lane and its grants", async () => {
    const db = await freshDb();
    const lane = await createLane(db, { slug: "bills" });
    const agent = await createAgent(db, "a");
    await grantLane(db, agent.agent.id, lane.id);
    expect((await api("DELETE", "/api/lanes/bills")).status).toBe(200);
    expect(await getLaneBySlug(db, "bills")).toBeNull();
    expect((await api("DELETE", "/api/lanes/bills")).status).toBe(404);
    expect((await api("GET", "/api/agents")).body[0].lanes).toEqual([]);
  });

  it("grants and ungrants a lane, but never to a revoked or unknown agent", async () => {
    const db = await freshDb();
    await createLane(db, { slug: "bills" });
    const agent = await createAgent(db, "a");
    const old = await createAgent(db, "old");
    await revokeAgent(db, old.agent.id);
    expect((await api("PUT", "/api/lanes/bills/grants/a")).status).toBe(200);
    expect((await api("GET", "/api/agents")).body.find((a: { name: string }) => a.name === "a").lanes).toEqual(["bills"]);
    expect((await api("DELETE", "/api/lanes/bills/grants/a")).status).toBe(200);
    expect((await api("PUT", "/api/lanes/bills/grants/old")).status).toBe(400);
    expect((await api("PUT", "/api/lanes/bills/grants/nobody")).status).toBe(404);
    expect(agent.token).toMatch(AGENT_TOKEN_PATTERN);
  });
});

describe("agents", () => {
  it("creates an agent with grants and returns its token once", async () => {
    const db = await freshDb();
    await createLane(db, { slug: "bills" });
    const { status, body } = await api("POST", "/api/agents", { name: "claude", lanes: ["bills"] });
    expect(status).toBe(201);
    expect(body.token).toMatch(AGENT_TOKEN_PATTERN);
    expect(body.agent).toMatchObject({ name: "claude", lanes: ["bills"], revoked_at: null });
    const listed = await api("GET", "/api/agents");
    expect(JSON.stringify(listed.body)).not.toContain(body.token);
    const stored = await testEnv().DB.prepare("SELECT token_hash FROM agents WHERE name = 'claude'").first<{ token_hash: string }>();
    expect(stored!.token_hash).not.toBe(body.token);
  });

  it("creates nothing when a lane is unknown or the name is taken or invalid", async () => {
    const db = await freshDb();
    expect((await api("POST", "/api/agents", { name: "claude", lanes: ["nope"] })).status).toBe(400);
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM agents"))!.n).toBe(0);
    await api("POST", "/api/agents", { name: "claude" });
    expect((await api("POST", "/api/agents", { name: "claude" })).status).toBe(409);
    expect((await api("POST", "/api/agents", { name: "bad name" })).status).toBe(400);
  });

  it("revokes an agent, once", async () => {
    await api("POST", "/api/agents", { name: "claude" });
    expect((await api("POST", "/api/agents/claude/revoke")).status).toBe(200);
    expect((await api("GET", "/api/agents")).body[0].revoked_at).toEqual(expect.any(String));
    expect((await api("POST", "/api/agents/claude/revoke")).status).toBe(404);
    expect((await api("POST", "/api/agents/nobody/revoke")).status).toBe(404);
  });
});

describe("messages", () => {
  it("lists and filters, and never includes a body", async () => {
    const db = await freshDb();
    const a = await createLane(db, { slug: "a" });
    const b = await createLane(db, { slug: "b" });
    const agent = await createAgent(db, "claude");
    await grantLane(db, agent.agent.id, a.id);
    const done = await addMessage(db, a.id);
    await markProcessed(db, agent.agent.id, "claude", done, "ok");
    await addMessage(db, a.id);
    await addMessage(db, b.id);

    const all = await api("GET", "/api/messages");
    expect(all.body).toHaveLength(3);
    expect(JSON.stringify(all.body)).not.toContain("secret body");
    expect((await api("GET", "/api/messages?lane=a")).body).toHaveLength(2);
    expect((await api("GET", "/api/messages?status=unprocessed")).body).toHaveLength(2);
    const processed = (await api("GET", "/api/messages?status=processed")).body;
    expect(processed).toHaveLength(1);
    expect(processed[0].processed).toEqual({ by: "claude", at: expect.any(String) });
    expect((await api("GET", "/api/messages?status=bogus")).status).toBe(400);
    expect((await api("GET", "/api/messages?lane=nope")).status).toBe(404);
    expect((await api("GET", "/api/messages?limit=0")).status).toBe(400);
  });

  it("names everything from the email untrusted", async () => {
    const db = await freshDb();
    const lane = await createLane(db, { slug: "a" });
    const id = await addMessage(db, lane.id, { originalFrom: "orig@example.com" }, [
      { id: ulid(), parentId: null, filename: "x.pdf", contentType: "application/pdf", size: 5, r2Key: "k", transformError: null },
    ]);
    const { body } = await api("GET", `/api/messages/${id}`);
    expect(body).toMatchObject({
      untrusted_subject: "Hello <b>there</b>",
      untrusted_envelope_from: "sender@example.com",
      untrusted_original_from: "orig@example.com",
      untrusted_auth_summary: "direct: dkim pass",
    });
    expect(body.attachments[0].untrusted_filename).toBe("x.pdf");
    const unprefixed = Object.keys(body).filter((k) => /subject|from|body|summary|note/.test(k) && !k.startsWith("untrusted_"));
    expect(unprefixed).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("secret body");
  });

  it("returns the body only from its own endpoint", async () => {
    const db = await freshDb();
    const lane = await createLane(db, { slug: "a" });
    const id = await addMessage(db, lane.id);
    expect((await api("GET", `/api/messages/${id}/body`)).body).toEqual({ untrusted_body: "The secret body text" });
    expect((await api("GET", "/api/messages/nope/body")).status).toBe(404);
  });

  it("marks unprocessed, keeps and deletes", async () => {
    const db = await freshDb();
    const lane = await createLane(db, { slug: "a" });
    const agent = await createAgent(db, "claude");
    const id = await addMessage(db, lane.id);
    await markProcessed(db, agent.agent.id, "claude", id, null);

    expect((await api("POST", `/api/messages/${id}/unprocess`)).status).toBe(200);
    expect((await api("GET", `/api/messages/${id}`)).body.processed).toBeNull();
    expect((await api("PUT", `/api/messages/${id}/keep`, { keep: true })).body).toEqual({ keep: true });
    expect((await api("GET", `/api/messages/${id}`)).body.keep).toBe(true);
    expect((await api("PUT", `/api/messages/${id}/keep`, { keep: "yes" })).status).toBe(400);
    expect((await api("DELETE", `/api/messages/${id}`)).status).toBe(200);
    expect((await api("GET", `/api/messages/${id}`)).status).toBe(404);
    expect((await api("DELETE", `/api/messages/${id}`)).status).toBe(404);
    expect((await api("POST", "/api/messages/nope/unprocess")).status).toBe(404);
  });

  it("downloads a stored attachment as a file, and 404s for a missing one", async () => {
    const db = await freshDb();
    const lane = await createLane(db, { slug: "a" });
    const attachmentId = ulid();
    await testEnv().BUCKET.put("files/a.pdf", new Uint8Array([37, 80, 68, 70]));
    const id = await addMessage(db, lane.id, {}, [
      { id: attachmentId, parentId: null, filename: 'in"voice.pdf', contentType: "application/pdf", size: 4, r2Key: "files/a.pdf", transformError: null },
      { id: "gone", parentId: null, filename: "b.pdf", contentType: "application/pdf", size: 4, r2Key: "files/missing.pdf", transformError: null },
    ]);
    const ok = await api("GET", `/api/attachments/${attachmentId}/download`);
    expect(ok.status).toBe(200);
    expect(ok.res.headers.get("content-disposition")).toBe('attachment; filename="in_voice.pdf"');
    expect(ok.res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await ok.res.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect((await api("GET", "/api/attachments/gone/download")).status).toBe(404);
    expect((await api("GET", "/api/attachments/nope/download")).status).toBe(404);
    await api("DELETE", `/api/messages/${id}`);
    expect((await api("GET", `/api/attachments/${attachmentId}/download`)).status).toBe(404);
  });
});

describe("rejections", () => {
  it("lists them, newest first, optionally for one lane", async () => {
    const db = await freshDb();
    const lane = await createLane(db, { slug: "a" });
    const base = { recipientHint: "x", envelopeFrom: "a@example.com", headerFrom: null };
    await logRejection(db, { ...base, bucket: "probe", reason: "unknown_address" }, 50, new Date(Date.now() - 5000));
    await logRejection(db, { ...base, bucket: "lane", reason: "auth_failed", detail: "d", diagnostics: "Authentication-Results: x", laneId: lane.id }, 50);
    const all = (await api("GET", "/api/rejections")).body;
    expect(all.map((r: { reason: string }) => r.reason)).toEqual(["auth_failed", "unknown_address"]);
    expect(all[0]).toMatchObject({ bucket: "lane", lane: "a", untrusted_detail: "d", untrusted_diagnostics: "Authentication-Results: x" });
    expect((await api("GET", "/api/rejections?lane=a")).body).toHaveLength(1);
    expect((await api("GET", "/api/rejections?lane=nope")).status).toBe(404);
  });
});
