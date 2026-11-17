import { describe, expect, it } from "vitest";
import { buildAddress, parseRecipient } from "../src/core/address";
import { base32, sha256Hex } from "../src/core/encoding";
import { LaneInput, SECRET_NAME_PATTERN, effectiveAllowedTypes } from "../src/core/lane-config";
import {
  AGENT_TOKEN_PATTERN,
  SHARE_TOKEN_PATTERN,
  generateAddressToken,
  generateAgentToken,
  generateShareToken,
} from "../src/core/tokens";
import { ulid } from "../src/core/ulid";

describe("encoding", () => {
  it("base32 matches RFC 4648 vectors (lower-case, unpadded)", () => {
    const enc = (s: string) => base32(new TextEncoder().encode(s));
    expect(enc("f")).toBe("my");
    expect(enc("fo")).toBe("mzxq");
    expect(enc("foobar")).toBe("mzxw6ytboi");
  });

  it("sha256Hex matches a known vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("tokens", () => {
  it("address tokens carry at least 128 bits and never repeat", () => {
    const a = generateAddressToken();
    expect(a).toMatch(/^[a-z2-7]{32}$/);
    expect((a.length * 5) >= 128).toBe(true);
    expect(generateAddressToken()).not.toBe(a);
  });

  it("agent and share tokens match their patterns", () => {
    expect(generateAgentToken()).toMatch(AGENT_TOKEN_PATTERN);
    expect(generateShareToken()).toMatch(SHARE_TOKEN_PATTERN);
  });
});

describe("ulid", () => {
  it("is 26 Crockford characters and sorts by time", () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});

describe("address", () => {
  const token = generateAddressToken();
  it("round-trips", () => {
    expect(parseRecipient(buildAddress(token, "mail.example.com"), "mail.example.com")).toBe(token);
  });
  it("is case-insensitive on host and local part", () => {
    expect(parseRecipient(`INBOX+${token.toUpperCase()}@MAIL.Example.com`, "mail.example.com")).toBe(token);
  });
  it("rejects other hosts, prefixes and short tokens", () => {
    expect(parseRecipient(buildAddress(token, "other.example.com"), "mail.example.com")).toBeNull();
    expect(parseRecipient(`sales+${token}@mail.example.com`, "mail.example.com")).toBeNull();
    expect(parseRecipient(`inbox@mail.example.com`, "mail.example.com")).toBeNull();
    expect(parseRecipient(`inbox+abc@mail.example.com`, "mail.example.com")).toBeNull();
    expect(parseRecipient("nonsense", "mail.example.com")).toBeNull();
  });
});

describe("lane config", () => {
  it("applies safe defaults: no attachments, not shareable, 90 days", () => {
    const lane = LaneInput.parse({ slug: "receipts" });
    expect(lane.attachment_policy.allowed_types).toEqual([]);
    expect(lane.attachment_policy.transforms).toEqual([]);
    expect(lane.shareable).toBe(false);
    expect(lane.retention_days).toBe(90);
    expect(lane.allowed_senders).toBeNull();
  });

  it("rejects unknown keys, bad slugs and oversized limits", () => {
    expect(() => LaneInput.parse({ slug: "ok", surprise: 1 })).toThrow();
    expect(() => LaneInput.parse({ slug: "Not Ok" })).toThrow();
    expect(() => LaneInput.parse({ slug: "ok", max_bytes: 999 * 1024 * 1024 })).toThrow();
  });

  it("restricts transform secrets to the lane-secret prefix", () => {
    const transform = (password_secret: string) => ({
      slug: "x",
      attachment_policy: {
        transforms: [{ type: "unzip", password_secret, allow_inner_types: ["application/pdf"] }],
      },
    });
    expect(LaneInput.parse(transform("LANE_SECRET_INVOICES")).attachment_policy.transforms).toHaveLength(1);
    expect(() => LaneInput.parse(transform("CLOUDFLARE_API_TOKEN"))).toThrow();
    expect(() => LaneInput.parse(transform("lane_secret_x"))).toThrow();
    expect(SECRET_NAME_PATTERN.test("LANE_SECRET_")).toBe(false);
  });

  it("an unzip transform implies zip is accepted", () => {
    const lane = LaneInput.parse({
      slug: "x",
      attachment_policy: {
        transforms: [{ type: "unzip", password_secret: "LANE_SECRET_X", allow_inner_types: ["application/pdf"] }],
      },
    });
    expect(effectiveAllowedTypes(lane.attachment_policy).has("application/zip")).toBe(true);
    expect(effectiveAllowedTypes(LaneInput.parse({ slug: "y" }).attachment_policy).size).toBe(0);
  });
});

describe("lane patch", () => {
  it("never fills in defaults for fields it was not given", async () => {
    const { LanePatch } = await import("../src/core/lane-config");
    expect(LanePatch.parse({})).toEqual({});
    expect(LanePatch.parse({ shareable: true })).toEqual({ shareable: true });
  });
});
