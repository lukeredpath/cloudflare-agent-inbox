import { z } from "zod";

export const MIB = 1024 * 1024;
/** Cloudflare Email Routing rejects anything larger than this before it reaches a Worker. */
export const HARD_MAX_MESSAGE_BYTES = 25 * MIB;

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Lane transforms may only read Worker secrets whose names start with this prefix. */
export const SECRET_NAME_PATTERN = /^LANE_SECRET_[A-Z0-9_]{1,48}$/;

export const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const mimeType = z.string().toLowerCase().regex(MIME_PATTERN);

export const UnzipTransform = z.strictObject({
  type: z.literal("unzip"),
  password_secret: z.string().regex(SECRET_NAME_PATTERN),
  allow_inner_types: z.array(mimeType).min(1).max(20),
});

export const Transform = z.discriminatedUnion("type", [UnzipTransform]);
export type Transform = z.infer<typeof Transform>;

export const AttachmentPolicy = z.strictObject({
  allowed_types: z.array(mimeType).max(20).default([]),
  max_attachment_bytes: z.number().int().min(1).max(HARD_MAX_MESSAGE_BYTES).default(5 * MIB),
  transforms: z.array(Transform).max(5).default([]),
});
export type AttachmentPolicy = z.infer<typeof AttachmentPolicy>;

export const VERDICTS = ["dmarc", "dkim", "spf"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Mail forwarded by a trusted forwarder (see TRUSTED_ARC_FORWARDERS) is accepted
 * only when the forwarder's ARC record shows the original sender authenticated.
 * `require` is any-of; the default is the strictest sensible one, DMARC.
 */
export const ForwardedFromRule = z.strictObject({
  from: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/),
  require: z.array(z.enum(VERDICTS)).min(1).max(3).default(["dmarc"]),
});
export type ForwardedFromRule = z.infer<typeof ForwardedFromRule>;

export const DEFAULT_MAX_BYTES = 10 * MIB;
export const DEFAULT_MAX_TEXT_CHARS = 50_000;
export const DEFAULT_RETENTION_DAYS = 90;

const address = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/);

// Field schemas carry no defaults, so a patch built from them never resets a
// field the caller did not mention. Defaults are applied only on creation.
const fields = {
  description: z.string().max(500),
  allowed_senders: z.array(address).min(1).max(20).nullable(),
  attachment_policy: AttachmentPolicy,
  forwarded_from: z.array(ForwardedFromRule).max(10),
  shareable: z.boolean(),
  max_bytes: z.number().int().min(1024).max(HARD_MAX_MESSAGE_BYTES),
  max_text_chars: z.number().int().min(100).max(500_000),
  retention_days: z.number().int().min(1).max(3650),
};

export const LaneInput = z.strictObject({
  slug: z.string().regex(SLUG_PATTERN),
  description: fields.description.default(""),
  allowed_senders: fields.allowed_senders.default(null),
  attachment_policy: fields.attachment_policy.default(() => AttachmentPolicy.parse({})),
  forwarded_from: fields.forwarded_from.default([]),
  shareable: fields.shareable.default(false),
  max_bytes: fields.max_bytes.default(DEFAULT_MAX_BYTES),
  max_text_chars: fields.max_text_chars.default(DEFAULT_MAX_TEXT_CHARS),
  retention_days: fields.retention_days.default(DEFAULT_RETENTION_DAYS),
});
export type LaneInput = z.infer<typeof LaneInput>;

/** Fields that may change after creation. The slug and address token do not. */
export const LanePatch = z.strictObject(fields).partial();
export type LanePatch = z.infer<typeof LanePatch>;

/** Types a lane accepts: its list, plus zip when it has an unzip transform. */
export function effectiveAllowedTypes(policy: AttachmentPolicy): Set<string> {
  const types = new Set(policy.allowed_types);
  if (policy.transforms.some((t) => t.type === "unzip")) types.add("application/zip");
  return types;
}
