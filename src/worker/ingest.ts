import PostalMime, { type Attachment } from "postal-mime";
import { stripInvisible, bodyToText, sanitiseText, FORWARDED_MARKER } from "../core/sanitise.ts";
import { normaliseAddress } from "../core/check-sender.ts";
import { effectiveAllowedTypes } from "../core/lane-config.ts";
import type { Lane } from "../core/lanes.ts";
import { safeFilename, sniffType } from "../core/sniff.ts";

/** Most attachments a single message may carry (a Free-plan subrequest budget guards the rest). */
export const MAX_ATTACHMENTS = 10;

export class IngestError extends Error {
  readonly reason: "parse_error" | "attachment_not_allowed";
  constructor(reason: "parse_error" | "attachment_not_allowed", detail: string) {
    super(detail);
    this.reason = reason;
  }
}

export interface IngestedAttachment {
  filename: string;
  type: string;
  bytes: Uint8Array;
}

export interface Ingested {
  subject: string | null;
  originalFrom: string | null;
  cleanText: string;
  attachments: IngestedAttachment[];
}

function toBytes(content: Attachment["content"]): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new TextEncoder().encode(String(content));
}

/** Embedded images (logos, tracking pixels) are dropped: they are never stored or policy-checked. */
const isInlineImage = (a: Attachment) => a.disposition === "inline" && Boolean(a.contentId) && a.mimeType.toLowerCase().startsWith("image/");

const cleanSubject = (subject: string | undefined) => {
  const s = stripInvisible(subject ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return s || null;
};

/**
 * Parses a raw message into clean text and a flat attachment list, then checks
 * the attachments against the lane's policy. Throws IngestError; stores nothing.
 */
export async function ingest(raw: Uint8Array, lane: Lane): Promise<Ingested> {
  let parsed;
  try {
    parsed = await PostalMime.parse(raw);
  } catch {
    throw new IngestError("parse_error", "message could not be parsed");
  }

  let body = bodyToText(parsed);
  let originalFrom: string | null = null;
  const candidates: { filename: string | null; mimeType: string; bytes: Uint8Array; index: number }[] = [];

  const collect = (attachments: Attachment[]) => {
    for (const a of attachments) {
      if (isInlineImage(a)) continue;
      candidates.push({ filename: a.filename, mimeType: a.mimeType, bytes: toBytes(a.content), index: candidates.length });
    }
  };

  // An email forwarded as an attachment: surface the inner message's text and
  // treat its attachments as the message's own. Its sender is untrusted metadata.
  let innerDone = false;
  for (const a of parsed.attachments) {
    if (!innerDone && a.mimeType.toLowerCase() === "message/rfc822") {
      innerDone = true;
      let inner;
      try {
        inner = await PostalMime.parse(toBytes(a.content));
      } catch {
        throw new IngestError("parse_error", "forwarded message could not be parsed");
      }
      originalFrom = inner.from?.address ? normaliseAddress(inner.from.address).slice(0, 320) : null;
      body += `\n\n${FORWARDED_MARKER}\n${bodyToText(inner)}`;
      collect(inner.attachments);
    } else {
      collect([a]);
    }
  }

  if (candidates.length > MAX_ATTACHMENTS) {
    throw new IngestError("attachment_not_allowed", `more than ${MAX_ATTACHMENTS} attachments`);
  }

  const allowed = effectiveAllowedTypes(lane.attachmentPolicy);
  const attachments: IngestedAttachment[] = candidates.map((c) => {
    const filename = safeFilename(c.filename, `attachment-${c.index + 1}`);
    const type = sniffType(c.bytes, filename, c.mimeType);
    if (c.bytes.byteLength > lane.attachmentPolicy.max_attachment_bytes) {
      throw new IngestError("attachment_not_allowed", "attachment too large");
    }
    if (!allowed.has(type)) throw new IngestError("attachment_not_allowed", `type ${type} not allowed`);
    return { filename, type, bytes: c.bytes };
  });

  return {
    subject: cleanSubject(parsed.subject),
    originalFrom,
    cleanText: sanitiseText(body, lane.maxTextChars),
    attachments,
  };
}
