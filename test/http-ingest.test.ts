import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/core/db";
import { sha256HexBytes } from "../src/core/encoding";
import {
  canonicalRequest,
  createIngestKey,
  generateIngestKeyPair,
  importIngestPrivateKey,
  INGEST_KEY_ID_PATTERN,
  INGEST_SECRET_PATTERN,
  listIngestKeys,
  MAX_ACTIVE_KEYS_PER_LANE,
  openSecret,
  revokeIngestKey,
  sealSecret,
  setIngestPublicKey,
  signRequest,
  verifySignature,
} from "../src/core/ingest-keys";
import { createLane, deleteLane, setLaneStatus, type Lane } from "../src/core/lanes";
import { resetAccessCache } from "../src/worker/admin/access";
import worker from "../src/worker/index";
import { AUD, makeKey, signJwt, stubAccessKeys, TEAM, type TestKey } from "./helpers/access";
import { freshDb } from "./helpers/db";
import { buildEml } from "./helpers/eml";
import { testEnv } from "./helpers/mail";

const HOST = "ingest.example.com";
const CRLF = "\r\n";

let db: Db;
let lane: Lane;
let other: Lane;
let accessKey: TestKey;
let privateJwk: string;
let laneKey: { id: string; secret: string };
let lines: Record<string, unknown>[];

const ingestEnv = (overrides: Record<string, unknown> = {}) =>
  testEnv({ INGEST_HOSTNAME: HOST, ACCESS_TEAM_DOMAIN: TEAM, INGEST_ACCESS_AUD: AUD, INGEST_PRIVATE_KEY: privateJwk, ...overrides });

/** A synthetic message with a Message-ID, as Postroom would send it. */
function eml(o: { messageId?: string | null; subject?: string; text?: string } = {}): Uint8Array {
  const base = new TextDecoder().decode(buildEml({ subject: o.subject ?? "Your bill is ready", text: o.text ?? "Synthetic body", auth: [] }));
  const id = o.messageId === undefined ? "<bill-1@billing.example.org>" : o.messageId;
  return new TextEncoder().encode(id === null ? base : `Message-ID: ${id}${CRLF}${base}`);
}

interface SendOptions {
  slug?: string;
  key?: { id: string; secret: string };
  body?: Uint8Array;
  timestamp?: number;
  /** Sign as if for this path (default: the request's own path). */
  signedPath?: string;
  signature?: string;
  access?: string | null;
  contentType?: string;
  method?: string;
  env?: Record<string, unknown>;
  path?: string;
}

async function send(o: SendOptions = {}): Promise<{ status: number; body: any; text: string }> {
  const key = o.key ?? laneKey;
  const body = o.body ?? eml();
  const path = o.path ?? `/ingest/lanes/${o.slug ?? lane.slug}`;
  const method = o.method ?? "POST";
  const timestamp = String(o.timestamp ?? Math.floor(Date.now() / 1000));
  const canonical = canonicalRequest(timestamp, method, o.signedPath ?? path, await sha256HexBytes(body as Uint8Array<ArrayBuffer>));
  const headers: Record<string, string> = {
    "content-type": o.contentType ?? "message/rfc822",
    "x-signature-key-id": key.id,
    "x-signature-timestamp": timestamp,
    "x-signature": o.signature ?? (await signRequest(key.secret, canonical)),
    "idempotency-key": "f".repeat(64),
  };
  const access = o.access === undefined ? await signJwt(accessKey, { email: undefined, common_name: "postroom.example" }) : o.access;
  if (access !== null) headers["cf-access-jwt-assertion"] = access;
  const res = await worker.fetch(
    new Request(`https://${HOST}${path}`, { method, headers, body: method === "GET" ? undefined : body }) as never,
    ingestEnv(o.env),
    createExecutionContext(),
  );
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed, text };
}

const messages = () => db.all<Record<string, unknown>>("SELECT * FROM messages");

beforeEach(async () => {
  lines = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
      try {
        lines.push(JSON.parse(String(a[0])));
      } catch {
        /* not ours */
      }
    });
  }
  resetAccessCache();
  accessKey = await makeKey();
  stubAccessKeys([accessKey]);
  db = await freshDb();
  const pair = await generateIngestKeyPair();
  privateJwk = pair.privateJwk;
  await setIngestPublicKey(db, pair.publicJwk);
  lane = await createLane(db, { slug: "bills" });
  other = await createLane(db, { slug: "other" });
  laneKey = await createIngestKey(db, lane.id);
  const bucket = testEnv().BUCKET;
  const listed = await bucket.list();
  if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
});
afterEach(() => vi.restoreAllMocks());

describe("POST /ingest/lanes/:lane", () => {
  it("files a signed message in the lane, stored as the email path stores it and tagged as from the API", async () => {
    const res = await send();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), duplicate: false });

    const [row] = await messages();
    expect(row).toMatchObject({
      id: res.body.id,
      lane_id: lane.id,
      source: "api",
      ingest_key_id: laneKey.id,
      message_id_header: "<bill-1@billing.example.org>",
      subject: "Your bill is ready",
      header_from: "sender@example.com",
    });
    expect(String(row!.clean_text)).toContain("Synthetic body");
    const raw = await testEnv().BUCKET.get(String(row!.raw_key));
    expect(new Uint8Array(await raw!.arrayBuffer())).toEqual(eml());

    const [key] = await listIngestKeys(db);
    expect(key!.lastUsedAt).not.toBeNull();
    expect(lines.find((l) => l.event === "ingest")).toMatchObject({ outcome: "accepted", status: 201, key: laneKey.id, lane: lane.id });
  });

  it("answers a repeat with 200 and the stored id, and stores nothing new", async () => {
    const first = await send();
    const objects = (await testEnv().BUCKET.list()).objects.length;
    const again = await send();
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ id: first.body.id, duplicate: true });
    expect(await messages()).toHaveLength(1);
    expect((await testEnv().BUCKET.list()).objects.length).toBe(objects);
  });

  it("treats a different body under the same Message-ID as a new message", async () => {
    await send();
    expect((await send({ body: eml({ text: "Another synthetic body" }) })).status).toBe(201);
    expect(await messages()).toHaveLength(2);
  });

  describe("every key, timestamp and signature failure is the same 401", () => {
    const expectRejected = async (res: { status: number; text: string }) => {
      expect(res.status).toBe(401);
      expect(res.text).toBe(JSON.stringify({ error: "unauthorized" }));
      expect(await messages()).toHaveLength(0);
    };

    it("rejects a bad signature", async () => {
      await expectRejected(await send({ signature: `sha256=${"0".repeat(64)}` }));
      await expectRejected(await send({ signature: "not-a-signature" }));
      await expectRejected(await send({ key: { id: laneKey.id, secret: `ais_${"a".repeat(52)}` } }));
    });

    it("rejects a body that does not match the signature", async () => {
      const signedFor = eml();
      const ts = String(Math.floor(Date.now() / 1000));
      const path = `/ingest/lanes/${lane.slug}`;
      const signature = await signRequest(laneKey.secret, canonicalRequest(ts, "POST", path, await sha256HexBytes(signedFor as Uint8Array<ArrayBuffer>)));
      await expectRejected(await send({ body: eml({ text: "Tampered" }), signature, timestamp: Number(ts) }));
    });

    it("rejects a stale or future timestamp", async () => {
      const now = Math.floor(Date.now() / 1000);
      await expectRejected(await send({ timestamp: now - 301 }));
      await expectRejected(await send({ timestamp: now + 301 }));
      expect((await send({ timestamp: now - 290 })).status).toBe(201);
    });

    it("rejects a key used against another lane, even when signed for that lane's path", async () => {
      await expectRejected(await send({ slug: other.slug }));
      // A signature for one lane's path cannot be replayed against another.
      await expectRejected(await send({ slug: other.slug, signedPath: `/ingest/lanes/${lane.slug}` }));
    });

    it("rejects a revoked key", async () => {
      await revokeIngestKey(db, laneKey.id);
      await expectRejected(await send());
    });

    it("rejects an unknown or malformed key id", async () => {
      await expectRejected(await send({ key: { id: "aik_aaaaaaaaaaaaaaaa", secret: laneKey.secret } }));
      await expectRejected(await send({ key: { id: "' OR 1=1 --", secret: laneKey.secret } }));
    });

    it("rejects keys of a deleted lane", async () => {
      await deleteLane(db, lane.id);
      await expectRejected(await send());
    });

    it("rejects a key whose sealed secret was made for another key pair", async () => {
      const replacement = await generateIngestKeyPair();
      await expectRejected(await send({ env: { INGEST_PRIVATE_KEY: replacement.privateJwk } }));
      expect(lines.find((l) => l.event === "ingest")).toMatchObject({ reason: "sealed_secret" });
    });
  });

  describe("Cloudflare Access", () => {
    it("rejects a request without an Access token before looking at the key", async () => {
      const res = await send({ access: null });
      expect(res.status).toBe(403);
      expect(await messages()).toHaveLength(0);
      expect(lines.find((l) => l.event === "ingest")).toMatchObject({ outcome: "access_denied", reason: "missing" });
    });

    it("rejects a token for another Access application", async () => {
      const res = await send({ access: await signJwt(accessKey, { aud: ["another-application"] }) });
      expect(res.status).toBe(403);
    });

    it("is not served unless fully configured", async () => {
      for (const missing of ["ACCESS_TEAM_DOMAIN", "INGEST_ACCESS_AUD", "INGEST_PRIVATE_KEY"]) {
        expect((await send({ env: { [missing]: undefined } })).status).toBe(503);
      }
      expect((await send({ env: { INGEST_HOSTNAME: undefined } })).status).toBe(404);
      expect(await messages()).toHaveLength(0);
    });
  });

  it("only answers POST on the lane path", async () => {
    expect((await send({ method: "GET" })).status).toBe(405);
    expect((await send({ path: "/ingest/lanes/" })).status).toBe(404);
    expect((await send({ path: "/mcp/agent" })).status).toBe(404);
  });

  it("requires message/rfc822", async () => {
    const res = await send({ contentType: "text/plain" });
    expect(res.status).toBe(415);
    expect(await messages()).toHaveLength(0);
  });

  it("requires From and Message-ID", async () => {
    const res = await send({ body: eml({ messageId: null }) });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("parse_error");
    expect(await messages()).toHaveLength(0);
  });

  it("applies the lane's policy: a paused lane refuses with 409", async () => {
    await setLaneStatus(db, lane.id, "paused");
    expect((await send()).status).toBe(409);
    expect(await messages()).toHaveLength(0);
  });

  it("refuses a message over the hard cap before reading it", async () => {
    const res = await worker.fetch(
      new Request(`https://${HOST}/ingest/lanes/${lane.slug}`, {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": await signJwt(accessKey),
          "x-signature-key-id": laneKey.id,
          "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-signature": `sha256=${"0".repeat(64)}`,
          "content-type": "message/rfc822",
          "content-length": String(26 * 1024 * 1024),
        },
        body: "x",
      }) as never,
      ingestEnv(),
      createExecutionContext(),
    );
    expect(res.status).toBe(413);
  });

  describe("rate limit per key", () => {
    const limiter = (success: boolean | "throw") => {
      const calls: { key: string }[] = [];
      return {
        calls,
        binding: {
          limit: async (o: { key: string }) => {
            calls.push(o);
            if (success === "throw") throw new Error("limiter down");
            return { success };
          },
        },
      };
    };

    it("limits signed requests by key id", async () => {
      const l = limiter(false);
      const res = await send({ env: { INGEST_LIMITER: l.binding } });
      expect(res.status).toBe(429);
      expect(l.calls).toEqual([{ key: laneKey.id }]);
      expect(await messages()).toHaveLength(0);
    });

    it("never counts unsigned requests", async () => {
      const l = limiter(false);
      expect((await send({ signature: `sha256=${"0".repeat(64)}`, env: { INGEST_LIMITER: l.binding } })).status).toBe(401);
      expect(l.calls).toEqual([]);
    });

    it("lets requests through when the limiter fails", async () => {
      expect((await send({ env: { INGEST_LIMITER: limiter("throw").binding } })).status).toBe(201);
    });
  });

  it("never logs the subject, addresses, body or secret", async () => {
    await send();
    await send({ signature: `sha256=${"0".repeat(64)}` });
    const logged = JSON.stringify(lines);
    for (const leak of ["Your bill is ready", "sender@example.com", "Synthetic body", laneKey.secret, "bill-1@billing.example.org"]) {
      expect(logged).not.toContain(leak);
    }
  });
});

describe("ingest keys", () => {
  it("generates ids and secrets in the documented formats", () => {
    expect(laneKey.id).toMatch(INGEST_KEY_ID_PATTERN);
    expect(laneKey.secret).toMatch(INGEST_SECRET_PATTERN);
  });

  it("never stores the secret in the clear", async () => {
    const [row] = await db.all<{ secret_box: string }>("SELECT secret_box FROM ingest_keys");
    expect(row!.secret_box).not.toContain(laneKey.secret);
    expect(row!.secret_box.startsWith("v1.")).toBe(true);
  });

  it("seals a secret that only the matching private key opens, bound to its key id and lane", async () => {
    const pair = await generateIngestKeyPair();
    const box = await sealSecret(pair.publicJwk, "aik_aaaaaaaaaaaaaaaa", "lane-1", "ais_secret");
    const key = await importIngestPrivateKey(pair.privateJwk);
    expect(await openSecret(key, box, "aik_aaaaaaaaaaaaaaaa", "lane-1")).toBe("ais_secret");
    expect(await openSecret(key, box, "aik_bbbbbbbbbbbbbbbb", "lane-1")).toBeNull();
    expect(await openSecret(key, box, "aik_aaaaaaaaaaaaaaaa", "lane-2")).toBeNull();
    expect(await openSecret(key, `${box}x`, "aik_aaaaaaaaaaaaaaaa", "lane-1")).toBeNull();
    expect(await openSecret(await importIngestPrivateKey((await generateIngestKeyPair()).privateJwk), box, "aik_aaaaaaaaaaaaaaaa", "lane-1")).toBeNull();
  });

  it(`allows ${MAX_ACTIVE_KEYS_PER_LANE} active keys per lane, so one can be swapped without downtime`, async () => {
    const second = await createIngestKey(db, lane.id);
    await expect(createIngestKey(db, lane.id)).rejects.toThrow("at most");
    expect((await send({ key: second })).status).toBe(201);
    await revokeIngestKey(db, laneKey.id);
    await expect(createIngestKey(db, lane.id)).resolves.toBeTruthy();
  });

  it("verifies signatures in constant time and only in the documented format", async () => {
    const sig = await signRequest("ais_x", "payload");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifySignature("ais_x", "payload", sig)).toBe(true);
    expect(await verifySignature("ais_x", "payload", sig.toUpperCase())).toBe(false);
    expect(await verifySignature("ais_x", "payload2", sig)).toBe(false);
  });

  it("deleting a lane revokes its keys", async () => {
    await deleteLane(db, lane.id);
    const rows = await db.all<{ revoked_at: string | null }>("SELECT revoked_at FROM ingest_keys");
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
  });
});
