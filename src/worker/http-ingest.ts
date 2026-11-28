import { d1Db } from "../core/db.ts";
import { sha256HexBytes } from "../core/encoding.ts";
import {
  canonicalRequest,
  findActiveIngestKey,
  findApiDuplicate,
  importIngestPrivateKey,
  openSecret,
  touchIngestKey,
  verifySignature,
} from "../core/ingest-keys.ts";
import { HARD_MAX_MESSAGE_BYTES } from "../core/lane-config.ts";
import { getLaneById } from "../core/lanes.ts";
import { verifyAccessJwt } from "./admin/access.ts";
import { storeMessage } from "./email.ts";
import type { Env } from "./env.ts";
import { IngestError, ingest } from "./ingest.ts";
import { logEvent, type LogFields } from "./log.ts";

/** How far a request's timestamp may be from the Worker's clock, either way. */
export const MAX_SKEW_SECONDS = 300;
const PATH = /^\/ingest\/lanes\/([a-z0-9][a-z0-9-]{0,62})$/;

const json = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

// One body for every key, timestamp and signature failure, so a caller learns nothing about which check failed.
const unauthorized = () => json(401, { error: "unauthorized" });

let privateKeyCache: { jwk: string; key: CryptoKey } | null = null;
async function privateKey(jwk: string): Promise<CryptoKey> {
  if (privateKeyCache?.jwk !== jwk) privateKeyCache = { jwk, key: await importIngestPrivateKey(jwk) };
  return privateKeyCache.key;
}

/**
 * POST /ingest/lanes/:slug on the ingest host: files one raw message into one lane. Access runs
 * first (and is checked again here), then the lane key, timestamp and HMAC signature, then the
 * same parsing, policy and storage as mail that arrives by Email Routing.
 */
export async function handleIngest(request: Request, env: Env): Promise<Response> {
  const started = Date.now();
  const fields: LogFields = {};
  const log = (status: number, outcome: string, extra: LogFields = {}) =>
    logEvent("ingest", { outcome, status, ...fields, ...extra, ms: Date.now() - started }, status >= 500 ? "error" : status >= 400 ? "warn" : "log");
  const done = (res: Response, outcome: string, extra: LogFields = {}) => {
    log(res.status, outcome, extra);
    return res;
  };

  // Fail closed: without every setting nothing on this host is served.
  if (!env.ACCESS_TEAM_DOMAIN || !env.INGEST_ACCESS_AUD || !env.INGEST_PRIVATE_KEY) {
    return done(json(503, { error: "not configured" }), "not_configured");
  }

  // 1. Cloudflare Access (service token). Access rejects these at the edge; this is the second lock.
  const access = await verifyAccessJwt(request.headers.get("cf-access-jwt-assertion"), {
    teamDomain: env.ACCESS_TEAM_DOMAIN.toLowerCase(),
    audience: env.INGEST_ACCESS_AUD,
  });
  if (!access.ok) {
    return access.reason === "keys_unavailable"
      ? done(json(503, { error: "unavailable" }), "access_unavailable")
      : done(json(403, { error: "forbidden" }), "access_denied", { reason: access.reason });
  }

  const url = new URL(request.url);
  const match = PATH.exec(url.pathname);
  if (!match) return done(json(404, { error: "not found" }), "not_found");
  if (request.method !== "POST") return done(json(405, { error: "method not allowed" }, { allow: "POST" }), "bad_method");
  const slug = match[1]!;

  const db = d1Db(env.DB);
  const keyId = request.headers.get("x-signature-key-id") ?? "";
  const timestamp = request.headers.get("x-signature-timestamp") ?? "";
  const signature = request.headers.get("x-signature") ?? "";

  // 2. The key exists, is not revoked and belongs to this lane.
  const key = keyId ? await findActiveIngestKey(db, keyId) : null;
  if (!key || key.laneSlug !== slug) return done(unauthorized(), "unauthorized", { reason: "key" });
  fields.key = key.id;
  fields.lane = key.laneId;

  // 3. The timestamp is fresh.
  const ts = /^\d{1,12}$/.test(timestamp) ? Number(timestamp) : NaN;
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) {
    return done(unauthorized(), "unauthorized", { reason: "timestamp" });
  }

  // The body is needed for the signature; refuse anything over the hard cap before reading it.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > HARD_MAX_MESSAGE_BYTES) return done(json(413, { error: "too large" }), "rejected", { reason: "too_large" });
  const raw = new Uint8Array(await request.arrayBuffer());
  fields.bytes = raw.byteLength;
  if (raw.byteLength > HARD_MAX_MESSAGE_BYTES) return done(json(413, { error: "too large" }), "rejected", { reason: "too_large" });

  // 4. The signature matches, compared in constant time.
  const bodySha256 = await sha256HexBytes(raw);
  const secret = await openSecret(await privateKey(env.INGEST_PRIVATE_KEY), key.secretBox, key.id, key.laneId);
  if (secret === null) {
    // A key that cannot be opened means the key pair was replaced; the caller still sees a plain 401.
    return done(unauthorized(), "unauthorized", { reason: "sealed_secret" });
  }
  const canonical = canonicalRequest(timestamp, request.method, url.pathname, bodySha256);
  if (!(await verifySignature(secret, canonical, signature))) return done(unauthorized(), "unauthorized", { reason: "signature" });

  // Rate limit per key. Only signed requests count, so nobody else can use up a lane's allowance.
  if (env.INGEST_LIMITER) {
    const allowed = await env.INGEST_LIMITER.limit({ key: key.id }).then(
      (r) => r.success,
      () => true,
    );
    if (!allowed) return done(json(429, { error: "rate limited" }, { "retry-after": "60" }), "rejected", { reason: "rate_limited" });
  }
  await touchIngestKey(db, key.id);

  // 5. Content type, lane state, size and parsing.
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "message/rfc822") return done(json(415, { error: "content type must be message/rfc822" }), "rejected", { reason: "content_type" });

  const lane = await getLaneById(db, key.laneId);
  if (!lane) return done(unauthorized(), "unauthorized", { reason: "key" });
  if (lane.status === "paused") return done(json(409, { error: "lane paused" }), "rejected", { reason: "lane_paused" });
  if (raw.byteLength > lane.maxBytes) return done(json(413, { error: "too large" }), "rejected", { reason: "too_large" });

  let ingested;
  try {
    ingested = await ingest(raw, lane);
  } catch (e) {
    if (e instanceof IngestError) return done(json(422, { error: e.reason }), "rejected", { reason: e.reason });
    throw e;
  }
  if (!ingested.fromAddress || !ingested.messageId) {
    return done(json(422, { error: "parse_error", detail: "From and Message-ID are required" }), "rejected", { reason: "parse_error" });
  }

  // Repeats are recognised by lane, Message-ID and body hash, and answered with the stored id.
  const repeat = await findApiDuplicate(db, lane.id, ingested.messageId, bodySha256);
  if (repeat) return done(json(200, { id: repeat, duplicate: true }), "duplicate");

  try {
    const stored = await storeMessage(env, db, lane, {
      raw,
      envelopeFrom: ingested.fromAddress,
      headerFrom: ingested.fromAddress,
      authSummary: `api key=${key.id}`,
      ingested,
      api: { keyId: key.id, messageIdHeader: ingested.messageId, bodySha256 },
    });
    return done(json(201, { id: stored.id, duplicate: false }), "accepted", { files: stored.files });
  } catch (e) {
    // Two copies at once: the unique index lets one in; the other answers as a repeat.
    const winner = await findApiDuplicate(db, lane.id, ingested.messageId, bodySha256).catch(() => null);
    if (winner) return done(json(200, { id: winner, duplicate: true }), "duplicate");
    return done(json(500, { error: "internal error" }), "error", { error: e instanceof Error ? e.name : "unknown" });
  }
}


