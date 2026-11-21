import type { LaneView, Verdict } from "../worker/admin/types.ts";

/*
 * The lane form's rules, mirrored from the Worker's schema (src/core/lane-config.ts) so mistakes show
 * as they are made. The Worker still validates everything: its answers are mapped back onto fields
 * by mapIssues, so nothing here has to be exhaustive.
 */

export const MIB = 1024 * 1024;
export const MAX_RULES = 100;
export const VERDICTS: Verdict[] = ["dmarc", "dkim", "spf"];

/** Types offered as checkboxes. A lane may allow any others through the free-text box. */
export const COMMON_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/heic",
  "text/csv",
  "application/zip",
  "message/rfc822",
];

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SECRET = /^LANE_SECRET_[A-Z0-9_]{1,48}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const SENDER = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const EXACT = /^[^\s@<>,;*()"]+@[^\s@<>,;*()"]+\.[^\s@<>,;*()"]+$/;
const DOMAIN_WILDCARD = /^\*@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export interface RuleRow {
  from: string;
  require: Verdict[];
  touched: boolean;
}

export interface LaneForm {
  slug: string;
  description: string;
  sendersMode: "default" | "list";
  senders: string;
  rules: RuleRow[];
  blocked: string;
  shareable: boolean;
  types: string[];
  otherTypes: string;
  /** In megabytes, as typed. */
  maxAtt: string;
  unzipOn: boolean;
  secret: string;
  inner: string[];
  innerOther: string;
  bytes: string;
  chars: string;
  days: string;
}

export type FieldKey = "slug" | "description" | "senders" | "rules" | "blocked" | "types" | "maxAtt" | "secret" | "inner" | "bytes" | "chars" | "days";
export type FieldErrors = Partial<Record<FieldKey, string>>;

export const FIELD_LABELS: Record<FieldKey, string> = {
  slug: "Lane name",
  description: "Description",
  senders: "Allowed senders",
  rules: "Forwarded-from rules",
  blocked: "Blocked senders",
  types: "Attachment types",
  maxAtt: "Max attachment size",
  secret: "Secret name",
  inner: "Allowed inner types",
  bytes: "Message size limit",
  chars: "Text characters",
  days: "Retention",
};

/** Split on lines, commas and spaces; lower-cased, de-duplicated, in order. */
export function splitList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

const splitLines = (text: string): string[] => [...new Set(text.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean))];

export function emptyForm(): LaneForm {
  return {
    slug: "",
    description: "",
    sendersMode: "default",
    senders: "",
    rules: [],
    blocked: "",
    shareable: false,
    types: ["application/pdf"],
    otherTypes: "",
    maxAtt: "5",
    unzipOn: false,
    secret: "",
    inner: ["application/pdf"],
    innerOther: "",
    bytes: "10",
    chars: "50000",
    days: "90",
  };
}

const mb = (bytes: number) => String(Number((bytes / MIB).toFixed(3)));

export function formFromLane(lane: LaneView): LaneForm {
  const unzip = lane.attachment_policy.transforms.find((t) => t.type === "unzip");
  const allowed = lane.attachment_policy.allowed_types;
  return {
    slug: lane.slug,
    description: lane.description,
    sendersMode: lane.allowed_senders ? "list" : "default",
    senders: (lane.allowed_senders ?? []).join("\n"),
    rules: lane.forwarded_from.map((r) => ({ from: r.from, require: [...r.require], touched: false })),
    blocked: lane.blocked_senders.join("\n"),
    shareable: lane.shareable,
    types: allowed.filter((t) => COMMON_TYPES.includes(t)),
    otherTypes: allowed.filter((t) => !COMMON_TYPES.includes(t)).join("\n"),
    maxAtt: mb(lane.attachment_policy.max_attachment_bytes),
    unzipOn: Boolean(unzip),
    secret: unzip?.password_secret ?? "",
    inner: unzip ? unzip.allow_inner_types.filter((t) => COMMON_TYPES.includes(t)) : ["application/pdf"],
    innerOther: unzip ? unzip.allow_inner_types.filter((t) => !COMMON_TYPES.includes(t)).join("\n") : "",
    bytes: mb(lane.max_bytes),
    chars: String(lane.max_text_chars),
    days: String(lane.retention_days),
  };
}

export const allowedTypes = (f: LaneForm): string[] => [...new Set([...f.types, ...splitList(f.otherTypes)])];
export const innerTypes = (f: LaneForm): string[] => [...new Set([...f.inner, ...splitList(f.innerOther)])];

type Kind = "any" | "domain" | "exact" | null;

function ruleKind(from: string): Kind {
  if (from === "*") return "any";
  if (DOMAIN_WILDCARD.test(from)) return "domain";
  return EXACT.test(from) ? "exact" : null;
}

/** The problem with one rule, or "". `rules` is every rule, to catch repeats. */
export function ruleError(rule: Pick<RuleRow, "from" | "require">, index: number, rules: Pick<RuleRow, "from">[]): string {
  const from = rule.from.trim().toLowerCase();
  if (!from) return "Enter an address, *@domain or *.";
  const kind = ruleKind(from);
  if (!kind) return "Use an address (name@example.com), *@domain or *.";
  if (kind !== "exact" && (rule.require.length !== 1 || rule.require[0] !== "dmarc")) return "Wildcard rules must require dmarc only.";
  if (rule.require.length === 0) return "Choose at least one verdict.";
  if (rules.findIndex((r) => r.from.trim().toLowerCase() === from) !== index) return "Duplicate of an earlier rule.";
  return "";
}

/** The problem with one blocked-sender entry (an address or *@domain), or "". */
function blockedError(entry: string): boolean {
  const kind = ruleKind(entry);
  return kind !== "exact" && kind !== "domain";
}

const whole = (text: string, lo: number, hi: number) => /^\d+$/.test(text.trim()) && +text >= lo && +text <= hi;
const size = (text: string) => (text.trim() !== "" && Number.isFinite(+text) ? Math.round(+text * MIB) : NaN);

export function validate(f: LaneForm, isNew: boolean): FieldErrors {
  const e: FieldErrors = {};
  if (isNew) {
    if (!f.slug) e.slug = "Enter a lane name.";
    else if (!SLUG.test(f.slug)) e.slug = "Use up to 40 lowercase letters, digits and hyphens, starting with a letter or digit.";
  }
  if (f.description.length > 500) e.description = `Keep it to 500 characters (currently ${f.description.length}).`;

  if (f.sendersMode === "list") {
    const list = splitLines(f.senders);
    const bad = list.filter((s) => !SENDER.test(s));
    if (list.length === 0) e.senders = "Add at least one sender, or use the deployment default.";
    else if (list.length > 20) e.senders = "A lane can list up to 20 senders.";
    else if (bad.length) e.senders = `Not a valid address: ${bad.slice(0, 2).join(", ")}${bad.length > 2 ? ` and ${bad.length - 2} more` : ""}.`;
  }

  if (f.rules.length > MAX_RULES) e.rules = `A lane can have up to ${MAX_RULES} rules.`;
  else if (f.rules.some((r, i, all) => ruleError(r, i, all))) e.rules = "Fix the highlighted rules.";

  const blocked = splitLines(f.blocked);
  const badBlocked = blocked.filter(blockedError);
  if (blocked.length > MAX_RULES) e.blocked = `A lane can block up to ${MAX_RULES} senders.`;
  else if (badBlocked.length) e.blocked = `Use an address or *@domain: ${badBlocked.slice(0, 2).join(", ")}${badBlocked.length > 2 ? ` and ${badBlocked.length - 2} more` : ""}.`;

  const types = allowedTypes(f);
  if (types.length > 20) e.types = "A lane can allow up to 20 types.";
  else if (types.some((t) => !MIME.test(t))) e.types = "Other types must look like type/subtype, for example image/webp.";

  const att = size(f.maxAtt);
  const msg = size(f.bytes);
  if (!(att >= 1 && att <= 25 * MIB)) e.maxAtt = "Enter a size from 1 byte up to 25 MB.";
  else if (msg >= 0 && att > msg) e.maxAtt = "Must not be larger than the message size limit.";
  if (!(msg >= 1024 && msg <= 25 * MIB)) e.bytes = "Enter a size from 0.001 to 25 MB.";

  if (f.unzipOn) {
    if (!SECRET.test(f.secret)) e.secret = "Start with LANE_SECRET_, then capital letters, digits and underscores, for example LANE_SECRET_SCHOOL.";
    const inner = innerTypes(f);
    if (inner.length === 0) e.inner = "Choose at least one inner type.";
    else if (inner.length > 20 || inner.some((t) => !MIME.test(t))) e.inner = "Use up to 20 types that look like type/subtype.";
  }

  if (!whole(f.chars, 100, 500_000)) e.chars = "Enter a whole number from 100 to 500,000.";
  if (!whole(f.days, 1, 3650)) e.days = "Enter a whole number of days from 1 to 3,650.";
  return e;
}

/** The request body: the Worker's own lane shape. `slug` is only sent when creating. */
export function toRequest(f: LaneForm, isNew: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    description: f.description.trim(),
    allowed_senders: f.sendersMode === "list" ? splitLines(f.senders) : null,
    forwarded_from: f.rules.map((r) => ({ from: r.from.trim().toLowerCase(), require: r.require })),
    blocked_senders: splitLines(f.blocked),
    shareable: f.shareable,
    attachment_policy: {
      allowed_types: allowedTypes(f),
      max_attachment_bytes: size(f.maxAtt),
      transforms: f.unzipOn ? [{ type: "unzip", password_secret: f.secret, allow_inner_types: innerTypes(f) }] : [],
    },
    max_bytes: size(f.bytes),
    max_text_chars: Number(f.chars),
    retention_days: Number(f.days),
  };
  if (isNew) body.slug = f.slug;
  return body;
}

/** `pattern [verdict ...]` per line; blank lines and # comments are skipped. Wildcards default to dmarc. */
export function parseBulk(text: string): { rules: { from: string; require: Verdict[] }[]; problems: string[] } {
  const rules: { from: string; require: Verdict[] }[] = [];
  const problems: string[] = [];
  const seen: { from: string }[] = [];
  text.split(/\r?\n/).forEach((line, n) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const [from = "", ...rest] = trimmed.split(/[\s,;]+/);
    const words = [...new Set(rest.map((w) => w.toLowerCase()))];
    const unknown = words.find((w) => !(VERDICTS as string[]).includes(w));
    const rule = { from: from.toLowerCase(), require: (words.length ? words : ["dmarc"]) as Verdict[] };
    const problem = unknown ? `unknown verdict "${unknown}"` : ruleError(rule, seen.length, [...seen, rule]);
    if (problem) problems.push(`Line ${n + 1}: ${problem.replace(/\.$/, "")}`);
    else {
      rules.push(rule);
      seen.push(rule);
    }
  });
  return { rules, problems };
}

export interface MappedIssues {
  fields: FieldErrors;
  /** Per-rule messages, by position in the list. */
  rules: Record<number, string>;
  /** Anything that did not belong to a field. */
  other: string[];
}

/** Puts the Worker's validation paths (for example `forwarded_from.2.from`) back onto the form's fields. */
export function mapIssues(issues: { path: string; message: string }[]): MappedIssues {
  const out: MappedIssues = { fields: {}, rules: {}, other: [] };
  for (const { path, message } of issues) {
    const [root = "", second = ""] = path.split(".");
    if (root === "forwarded_from") {
      if (/^\d+$/.test(second)) out.rules[Number(second)] = message;
      out.fields.rules = /^\d+$/.test(second) ? "Fix the highlighted rules." : message;
    } else if (root === "attachment_policy") {
      if (second === "allowed_types") out.fields.types = message;
      else if (second === "max_attachment_bytes") out.fields.maxAtt = message;
      else if (second === "transforms") out.fields[path.endsWith("allow_inner_types") ? "inner" : "secret"] = message;
      else out.other.push(message);
    } else {
      const field: Record<string, FieldKey> = {
        slug: "slug",
        description: "description",
        allowed_senders: "senders",
        blocked_senders: "blocked",
        max_bytes: "bytes",
        max_text_chars: "chars",
        retention_days: "days",
      };
      const key = field[root];
      if (key) out.fields[key] = message;
      else out.other.push(message);
    }
  }
  return out;
}
