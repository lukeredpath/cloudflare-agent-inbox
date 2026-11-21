import { describe, expect, it } from "vitest";
import { LaneInput, LanePatch } from "../src/core/lane-config";
import {
  emptyForm,
  formFromLane,
  mapIssues,
  parseBulk,
  ruleError,
  toRequest,
  validate,
  type LaneForm,
} from "../src/admin/lane-form-model";
import type { LaneView } from "../src/worker/admin/types";

const valid = (over: Partial<LaneForm> = {}): LaneForm => ({ ...emptyForm(), slug: "receipts", ...over });

describe("lane form validation", () => {
  it("accepts the defaults for a new lane with a name", () => {
    expect(validate(valid(), true)).toEqual({});
  });

  it("checks the name only when creating", () => {
    expect(validate(valid({ slug: "" }), true).slug).toBeDefined();
    expect(validate(valid({ slug: "Has Space" }), true).slug).toBeDefined();
    expect(validate(valid({ slug: "" }), false).slug).toBeUndefined();
  });

  it("lets a lane have no forwarded-from rules and no allowed types", () => {
    expect(validate(valid({ rules: [], types: [] }), true)).toEqual({});
  });

  it("validates each rule and the list as a whole", () => {
    const rule = (from: string, require = ["dmarc"] as ("dmarc" | "dkim" | "spf")[]) => ({ from, require, touched: false });
    expect(ruleError(rule("a@example.com", ["dkim", "spf"]), 0, [rule("a@example.com")])).toBe("");
    expect(ruleError(rule(""), 0, [rule("")])).toMatch(/Enter/);
    expect(ruleError(rule("nonsense"), 0, [rule("nonsense")])).toMatch(/Use an address/);
    expect(ruleError(rule("*@example.com", ["dkim"]), 0, [rule("*@example.com")])).toMatch(/dmarc only/);
    expect(ruleError(rule("*", ["dmarc", "spf"]), 0, [rule("*")])).toMatch(/dmarc only/);
    expect(ruleError(rule("a@example.com", []), 0, [rule("a@example.com")])).toMatch(/at least one/);
    const rules = [rule("a@example.com"), rule("A@example.com")];
    expect(ruleError(rules[1]!, 1, rules)).toMatch(/Duplicate/);
    expect(validate(valid({ rules: [rule("bad")] }), true).rules).toBeDefined();
    expect(validate(valid({ rules: Array.from({ length: 101 }, (_, i) => rule(`u${i}@example.com`)) }), true).rules).toMatch(/100/);
  });

  it("checks senders, sizes, counts and the unzip settings against the Worker's limits", () => {
    expect(validate(valid({ sendersMode: "list", senders: "" }), true).senders).toBeDefined();
    expect(validate(valid({ sendersMode: "list", senders: "ok@example.com\nnot-an-address" }), true).senders).toMatch(/not-an-address/);
    expect(validate(valid({ maxAtt: "26" }), true).maxAtt).toBeDefined();
    expect(validate(valid({ maxAtt: "20", bytes: "10" }), true).maxAtt).toMatch(/larger/);
    expect(validate(valid({ bytes: "0" }), true).bytes).toBeDefined();
    expect(validate(valid({ chars: "99" }), true).chars).toBeDefined();
    expect(validate(valid({ chars: "500001" }), true).chars).toBeDefined();
    expect(validate(valid({ days: "0" }), true).days).toBeDefined();
    expect(validate(valid({ days: "3651" }), true).days).toBeDefined();
    expect(validate(valid({ otherTypes: "not a type" }), true).types).toBeDefined();
    expect(validate(valid({ unzipOn: true, secret: "SCHOOL_ZIP" }), true).secret).toMatch(/LANE_SECRET_/);
    expect(validate(valid({ unzipOn: true, secret: "LANE_SECRET_SCHOOL", inner: [] }), true).inner).toBeDefined();
    expect(validate(valid({ unzipOn: true, secret: "LANE_SECRET_SCHOOL" }), true)).toEqual({});
  });
});

describe("lane form request", () => {
  it("builds a body the Worker's schema accepts, for both create and update", () => {
    const form = valid({
      description: " Shop receipts ",
      sendersMode: "list",
      senders: "A@Example.com\nb@example.com",
      rules: [{ from: "*@Shop.example.com", require: ["dmarc"], touched: false }],
      shareable: true,
      types: ["application/pdf", "application/zip"],
      otherTypes: "image/webp",
      unzipOn: true,
      secret: "LANE_SECRET_SCHOOL",
      innerOther: "image/webp",
      maxAtt: "4.5",
      bytes: "12",
    });
    const create = toRequest(form, true);
    const parsed = LaneInput.parse(create);
    expect(parsed.description).toBe("Shop receipts");
    expect(parsed.allowed_senders).toEqual(["a@example.com", "b@example.com"]);
    expect(parsed.forwarded_from).toEqual([{ from: "*@shop.example.com", require: ["dmarc"] }]);
    expect(parsed.attachment_policy.max_attachment_bytes).toBe(4.5 * 1024 * 1024);
    expect(parsed.attachment_policy.allowed_types).toEqual(["application/pdf", "application/zip", "image/webp"]);
    expect(parsed.attachment_policy.transforms).toEqual([
      { type: "unzip", password_secret: "LANE_SECRET_SCHOOL", allow_inner_types: ["application/pdf", "image/webp"] },
    ]);
    const update = toRequest(form, false);
    expect(update.slug).toBeUndefined();
    expect(() => LanePatch.parse(update)).not.toThrow();
  });

  it("sends no sender list for the deployment default, and no transform when unzip is off", () => {
    const body = toRequest(valid(), true) as { allowed_senders: unknown; attachment_policy: { transforms: unknown[] } };
    expect(body.allowed_senders).toBeNull();
    expect(body.attachment_policy.transforms).toEqual([]);
  });

  it("round-trips a lane through the form", () => {
    const lane: LaneView = {
      slug: "school",
      description: "Letters",
      status: "active",
      address_masked: "x",
      allowed_senders: ["office@example.org"],
      forwarded_from: [{ from: "office@example.org", require: ["dmarc", "dkim"] }],
      blocked_senders: ["noreply@example.net"],
      shareable: true,
      attachment_policy: {
        allowed_types: ["application/pdf", "image/webp"],
        max_attachment_bytes: 5 * 1024 * 1024,
        transforms: [{ type: "unzip", password_secret: "LANE_SECRET_X", allow_inner_types: ["application/pdf"] }],
      },
      max_bytes: 10 * 1024 * 1024,
      max_text_chars: 50_000,
      retention_days: 90,
      created_at: "",
      updated_at: "",
    };
    const form = formFromLane(lane);
    expect(validate(form, false)).toEqual({});
    const body = toRequest(form, false) as Record<string, unknown>;
    expect(body).toMatchObject({
      description: "Letters",
      allowed_senders: ["office@example.org"],
      forwarded_from: lane.forwarded_from,
      shareable: true,
      max_bytes: lane.max_bytes,
      max_text_chars: 50_000,
      retention_days: 90,
      attachment_policy: lane.attachment_policy,
    });
  });
});

describe("bulk rules", () => {
  it("parses lines, defaults to dmarc, and reports problems by line", () => {
    const { rules, problems } = parseBulk(
      ["# comment", "", "a@example.com dkim spf", "*@shop.example.com", "*", "bad line here", "c@example.com nonsense", "a@example.com"].join("\n"),
    );
    expect(rules).toEqual([
      { from: "a@example.com", require: ["dkim", "spf"] },
      { from: "*@shop.example.com", require: ["dmarc"] },
      { from: "*", require: ["dmarc"] },
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^Line 6/);
    expect(problems[1]).toMatch(/unknown verdict "nonsense"/);
    expect(problems[2]).toMatch(/Duplicate/);
  });
});

describe("mapping the Worker's validation paths", () => {
  it("puts issues on fields and rules", () => {
    const mapped = mapIssues([
      { path: "slug", message: "bad slug" },
      { path: "forwarded_from.2.from", message: "must be an address" },
      { path: "forwarded_from", message: "each From pattern may appear only once" },
      { path: "attachment_policy.max_attachment_bytes", message: "too big" },
      { path: "attachment_policy.transforms.0.password_secret", message: "bad secret" },
      { path: "attachment_policy.transforms.0.allow_inner_types", message: "bad inner" },
      { path: "retention_days", message: "too long" },
      { path: "mystery", message: "who knows" },
    ]);
    expect(mapped.fields).toMatchObject({ slug: "bad slug", maxAtt: "too big", secret: "bad secret", inner: "bad inner", days: "too long" });
    expect(mapped.rules).toEqual({ 2: "must be an address" });
    expect(mapped.fields.rules).toBe("each From pattern may appear only once");
    expect(mapped.other).toEqual(["who knows"]);
  });
});
