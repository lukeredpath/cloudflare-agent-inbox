import { z } from "zod";
import { isPublicSuffix } from "./domains.ts";

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

/** A single address: no whitespace, separators, brackets or wildcards. */
export const EXACT_ADDRESS = /^[^\s@<>,;*()"]+@[^\s@<>,;*()"]+\.[^\s@<>,;*()"]+$/;
const DOMAIN_WILDCARD = /^\*@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

export type FromKind = "exact" | "domain" | "any";

/** What a rule's `from` is, or null if it is not a valid address, `*@domain` or `*`. */
export function fromKind(from: string): FromKind | null {
  if (from === "*") return "any";
  const domain = DOMAIN_WILDCARD.exec(from)?.[1];
  if (domain) return isPublicSuffix(domain) ? null : "domain";
  return EXACT_ADDRESS.test(from) ? "exact" : null;
}

/**
 * Mail forwarded by a trusted forwarder (see TRUSTED_ARC_FORWARDERS) is accepted
 * only when the forwarder's ARC record shows the original sender authenticated.
 * `from` is an address, `*@domain` (that exact domain, not its subdomains) or `*`.
 * `require` is any-of; the default is the strictest sensible one, DMARC. A wildcard
 * vouches for senders nobody listed, so it may require nothing but DMARC.
 */
export const ForwardedFromRule = z
  .strictObject({
    from: z
      .string()
      .trim()
      .toLowerCase()
      .refine((v) => fromKind(v) !== null, "must be an address, *@domain (not a public suffix) or *"),
    require: z.array(z.enum(VERDICTS)).min(1).max(3).default(["dmarc"]),
  })
  .refine((r) => fromKind(r.from) === "exact" || (r.require.length === 1 && r.require[0] === "dmarc"), {
    message: "a wildcard rule must require exactly dmarc",
    path: ["require"],
  });
export type ForwardedFromRule = z.infer<typeof ForwardedFromRule>;

/** The rule for a From address: an exact match, else its domain's wildcard, else `*`. Only that one is used. */
export function findForwardedRule(rules: ForwardedFromRule[], address: string): ForwardedFromRule | undefined {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return (
    rules.find((r) => r.from === address) ?? rules.find((r) => r.from === `*@${domain}`) ?? rules.find((r) => r.from === "*")
  );
}

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
  forwarded_from: z
    .array(ForwardedFromRule)
    .max(10)
    .refine((rules) => new Set(rules.map((r) => r.from)).size === rules.length, "each From pattern may appear only once"),
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
