import {
  checkSender,
  extractAddress,
  normaliseAddress,
  parseList,
} from "../core/check-sender.ts";
import { d1Db, type Db } from "../core/db.ts";
import { parseRecipient } from "../core/address.ts";
import { HARD_MAX_MESSAGE_BYTES } from "../core/lane-config.ts";
import { getLaneByToken, type Lane } from "../core/lanes.ts";
import { insertMessage, type NewAttachment } from "../core/messages.ts";
import {
  DEFAULT_MAX_REJECTED_PER_DAY,
  logRejection,
  recipientHint,
  type RejectionReason,
} from "../core/rejections.ts";
import { ulid } from "../core/ulid.ts";
import type { Env } from "./env.ts";
import { IngestError, ingest, type IngestedAttachment } from "./ingest.ts";
import { logEvent, type LogFields } from "./log.ts";
import { runTransforms } from "./transforms.ts";

/** Objects written per message, kept inside the Free plan's subrequest budget. */
const MAX_STORED_FILES = 30;

const positiveInt = (value: string | undefined, fallback: number) => {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

async function readRaw(message: ForwardableEmailMessage): Promise<Uint8Array> {
  return new Uint8Array(await new Response(message.raw).arrayBuffer());
}

interface StoredFile {
  id: string;
  parentId: string | null;
  filename: string;
  type: string;
  bytes: Uint8Array;
  key: string;
  transformError: string | null;
}

/**
 * Handles one inbound message. Everything except a paused lane is dropped
 * silently, so a prober learns nothing and no bounce traffic is created.
 * Nothing rejected is stored; each rejection is logged headers-only.
 */
export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const db = d1Db(env.DB);
  const cap = positiveInt(env.MAX_REJECTED_PER_DAY, DEFAULT_MAX_REJECTED_PER_DAY);
  const envelopeFrom = normaliseAddress(message.from);
  const headerFrom = normaliseAddress(extractAddress(message.headers.get("from") ?? "")) || null;
  const base = { recipientHint: recipientHint(message.to), envelopeFrom, headerFrom };
  let authenticated = false;
  let laneId: string | null = null;

  // One structured line per message with its outcome, so Workers Logs alone can show what
  // happened. Metadata only: no addresses, subjects or content.
  const started = Date.now();
  const log = (outcome: "accepted" | "rejected" | "error", extra: LogFields = {}) =>
    logEvent("email", { outcome, lane: laneId, bytes: message.rawSize, ms: Date.now() - started, ...extra }, outcome === "error" ? "error" : "log");

  try {
    const token = parseRecipient(message.to, env.MAIL_HOSTNAME);
    const lane = token ? await getLaneByToken(db, token) : null;
    if (!lane) {
      log("rejected", { reason: "unknown_address" });
      await logRejection(db, { ...base, bucket: "probe", reason: "unknown_address" }, cap);
      return;
    }
    laneId = lane.id;
    const reject = (reason: RejectionReason, detail?: string, diagnostics?: string) => {
      log("rejected", { reason });
      return logRejection(db, { ...base, bucket: "lane", reason, detail, diagnostics, laneId: lane.id }, cap);
    };

    // Cheap size check first, before reading the body.
    const limit = Math.min(lane.maxBytes, HARD_MAX_MESSAGE_BYTES);
    if (message.rawSize > limit) return void (await reject("too_large"));
    const raw = await readRaw(message);
    if (raw.byteLength > limit) return void (await reject("too_large"));

    const verdict = checkSender(raw, envelopeFrom, {
      allowedSenders: lane.allowedSenders ?? parseList(env.DEFAULT_ALLOWED_SENDERS),
      allowedDkimDomains: parseList(env.ALLOWED_DKIM_DOMAINS),
      trustedArcForwarders: parseList(env.TRUSTED_ARC_FORWARDERS),
      forwardedFrom: lane.forwardedFrom,
    });
    if (!verdict.allowed) return void (await reject(verdict.reason, verdict.detail, verdict.diagnostics));
    authenticated = true;

    // Only a verified forward from an allowed sender can bounce, so the paused
    // state is not visible to anyone else.
    if (lane.status === "paused") {
      await reject("lane_paused");
      message.setReject("This address is not accepting mail");
      return;
    }

    let ingested;
    try {
      ingested = await ingest(raw, lane);
    } catch (e) {
      if (e instanceof IngestError) return void (await reject(e.reason, e.message));
      throw e;
    }

    const files = await storeMessage(env, db, lane, {
      raw,
      envelopeFrom,
      headerFrom,
      authSummary: verdict.summary,
      ingested,
    });
    log("accepted", { path: verdict.path, files });
  } catch (e) {
    log("error", { error: e instanceof Error ? e.name : "unknown", authenticated });
    // A verified forward that we could not store must not vanish silently. This is a permanent
    // rejection, so the sender is told to resend rather than that it will be retried.
    if (authenticated) message.setReject("The message could not be processed. Please send it again.");
  }
}

async function storeMessage(
  env: Env,
  db: Db,
  lane: Lane,
  input: {
    raw: Uint8Array;
    envelopeFrom: string;
    headerFrom: string | null;
    authSummary: string;
    ingested: Awaited<ReturnType<typeof ingest>>;
  },
): Promise<number> {
  const messageId = ulid();
  const prefix = `lanes/${lane.id}/${messageId}`;
  const files: StoredFile[] = [];
  let n = 0;
  const add = (a: IngestedAttachment, parentId: string | null, transformError: string | null): StoredFile => {
    n += 1;
    const file: StoredFile = {
      id: ulid(),
      parentId,
      filename: a.filename,
      type: a.type,
      bytes: a.bytes,
      key: `${prefix}/attachments/${n}-${a.filename}`,
      transformError,
    };
    files.push(file);
    return file;
  };

  for (const attachment of input.ingested.attachments) {
    const budget = MAX_STORED_FILES - 1 - files.length - 1;
    const result = await runTransforms(lane, attachment, env, Math.max(0, budget));
    const parent = add(attachment, null, result.error);
    for (const child of result.children) add(child, parent.id, null);
  }

  const rawKey = `${prefix}/raw.eml`;
  const written: string[] = [];
  try {
    await env.BUCKET.put(rawKey, input.raw, { httpMetadata: { contentType: "message/rfc822" } });
    written.push(rawKey);
    for (const f of files) {
      await env.BUCKET.put(f.key, f.bytes, { httpMetadata: { contentType: f.type } });
      written.push(f.key);
    }
    const attachments: NewAttachment[] = files.map((f) => ({
      id: f.id,
      parentId: f.parentId,
      filename: f.filename,
      contentType: f.type,
      size: f.bytes.byteLength,
      r2Key: f.key,
      transformError: f.transformError,
    }));
    await insertMessage(
      db,
      {
        id: messageId,
        laneId: lane.id,
        receivedAt: new Date().toISOString(),
        envelopeFrom: input.envelopeFrom,
        headerFrom: input.headerFrom,
        originalFrom: input.ingested.originalFrom,
        subject: input.ingested.subject,
        size: input.raw.byteLength,
        authSummary: input.authSummary,
        cleanText: input.ingested.cleanText,
        rawKey,
        isTest: false,
      },
      attachments,
    );
    return files.length;
  } catch (e) {
    // Nothing partial is left behind.
    await env.BUCKET.delete(written).catch(() => {});
    throw e;
  }
}
