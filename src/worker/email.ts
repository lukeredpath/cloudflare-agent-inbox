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

  try {
    const token = parseRecipient(message.to, env.MAIL_HOSTNAME);
    const lane = token ? await getLaneByToken(db, token) : null;
    if (!lane) {
      await logRejection(db, { ...base, bucket: "probe", reason: "unknown_address" }, cap);
      return;
    }
    const reject = (reason: RejectionReason, detail?: string) =>
      logRejection(db, { ...base, bucket: "lane", reason, detail, laneId: lane.id }, cap);

    // Cheap size check first, before reading the body.
    const limit = Math.min(lane.maxBytes, HARD_MAX_MESSAGE_BYTES);
    if (message.rawSize > limit) return void (await reject("too_large"));
    const raw = await readRaw(message);
    if (raw.byteLength > limit) return void (await reject("too_large"));

    const verdict = checkSender(raw, envelopeFrom, {
      allowedSenders: lane.allowedSenders ?? parseList(env.DEFAULT_ALLOWED_SENDERS),
      allowedDkimDomains: parseList(env.ALLOWED_DKIM_DOMAINS),
    });
    if (!verdict.allowed) return void (await reject(verdict.reason, verdict.detail));
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

    await storeMessage(env, db, lane, {
      raw,
      envelopeFrom,
      headerFrom,
      authSummary: verdict.summary,
      ingested,
    });
  } catch (e) {
    // Metadata only: never message content or deployment values.
    console.error(JSON.stringify({ event: "email_error", error: e instanceof Error ? e.name : "unknown", authenticated }));
    // A verified forward that we could not store must not vanish silently.
    if (authenticated) message.setReject("Temporary processing failure");
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
): Promise<void> {
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
  } catch (e) {
    // Nothing partial is left behind.
    await env.BUCKET.delete(written).catch(() => {});
    throw e;
  }
}
