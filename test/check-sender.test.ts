import { describe, expect, it } from "vitest";
import { checkSender, cloudflareAuthResults, extractAddress, parseList } from "../src/core/check-sender";
import { AUTH_FORGED, AUTH_NONE, AUTH_OTHER_SERVER, AUTH_PASS, buildEml } from "./helpers/eml";

const policy = { allowedSenders: ["sender@example.com"], allowedDkimDomains: ["example.com"] };
const check = (auth: string[], envelope = "sender@example.com", p = policy) =>
  checkSender(buildEml({ auth }), envelope, p);

// Ported from the previous implementation's cases: a genuine forward is accepted,
// every spoof is rejected.
describe("checkSender", () => {
  it("accepts a genuine forward (envelope allowed, Cloudflare dkim=pass)", () => {
    expect(check([AUTH_PASS()])).toEqual({ allowed: true, summary: "dkim=pass header.d=example.com" });
  });

  it("rejects a spoofed From with no DKIM", () => {
    expect(check([AUTH_NONE])).toMatchObject({ allowed: false, reason: "auth_failed" });
  });

  it("rejects a forged Authentication-Results header below Cloudflare's", () => {
    expect(check([AUTH_NONE, AUTH_FORGED])).toMatchObject({ allowed: false, reason: "auth_failed" });
  });

  it("rejects when the first Authentication-Results is not from Cloudflare", () => {
    expect(check([AUTH_OTHER_SERVER, AUTH_PASS()])).toMatchObject({ allowed: false, reason: "auth_failed" });
  });

  it("rejects a DKIM pass for another domain", () => {
    expect(check([AUTH_PASS("gmail.com")])).toMatchObject({ allowed: false, reason: "auth_failed" });
  });

  it("rejects an envelope sender that is not allowlisted, even with a passing header", () => {
    expect(check([AUTH_PASS()], "attacker@example.org")).toMatchObject({ allowed: false, reason: "sender_not_allowed" });
  });

  it("rejects when there is no Authentication-Results at all", () => {
    expect(check([])).toMatchObject({ allowed: false, reason: "auth_failed" });
  });

  it("fails closed when no DKIM domains are configured", () => {
    expect(check([AUTH_PASS()], "sender@example.com", { ...policy, allowedDkimDomains: [] })).toMatchObject({
      allowed: false,
      reason: "auth_failed",
    });
  });

  it("does not echo the envelope sender in its detail", () => {
    const v = check([AUTH_PASS()], "attacker@example.org");
    expect(JSON.stringify(v)).not.toContain("attacker");
  });
});

describe("helpers", () => {
  it("reads folded Authentication-Results", () => {
    expect(cloudflareAuthResults(buildEml({ auth: [AUTH_PASS()] }))).toContain("dmarc=pass");
  });
  it("parses lists and addresses", () => {
    expect(parseList(" A@x.com, ,b@y.com ")).toEqual(["a@x.com", "b@y.com"]);
    expect(extractAddress("Name <a@b.c>")).toBe("a@b.c");
    expect(extractAddress("a@b.c")).toBe("a@b.c");
  });
});
