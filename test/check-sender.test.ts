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
    expect(check([AUTH_PASS()])).toEqual({ allowed: true, summary: "dkim=pass header.d=example.com spf=pass", path: "direct" });
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

// Path A must bind the signature to the sender: a pass for some other allowed domain, or
// without SPF for the envelope sender, is not enough.
describe("checkSender: direct path binds the signature to the sender", () => {
  const ar = (dkimDomain: string, spf: string, mailfrom: string) =>
    `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${dkimDomain}; spf=${spf} smtp.mailfrom=${mailfrom}`;
  const run = (line: string, envelope: string, p: Partial<typeof policy> = {}) =>
    checkSender(buildEml({ auth: [line] }), envelope, { ...policy, ...p });

  it("requires an spf pass for the envelope sender, so a replayed signed message fails", () => {
    const v = run(ar("example.com", "fail", "sender@example.com"), "sender@example.com");
    expect(v).toMatchObject({ allowed: false, reason: "auth_failed" });
    expect((v as { detail: string }).detail).toMatch(/dkim passed but there was no spf=pass/);
    expect(run(ar("example.com", "none", "sender@example.com"), "sender@example.com").allowed).toBe(false);
  });

  it("requires the spf pass to be for this envelope sender, not another address", () => {
    expect(run(ar("example.com", "pass", "someone-else@example.com"), "sender@example.com").allowed).toBe(false);
  });

  it("requires the signing domain to match the envelope sender's domain", () => {
    // An unrelated domain on the allowlist must not vouch for this sender.
    const p = { allowedDkimDomains: ["example.com", "other.example.net"] };
    expect(run(ar("other.example.net", "pass", "sender@example.com"), "sender@example.com", p).allowed).toBe(false);
  });

  it("blocks the shared-provider replay: another account's signature with the victim's envelope", () => {
    const p = { allowedSenders: ["owner@shared.example.net"], allowedDkimDomains: ["shared.example.net"] };
    // The attacker's own message, signed by the shared provider, sent from their server with the owner's envelope.
    expect(run(ar("shared.example.net", "fail", "owner@shared.example.net"), "owner@shared.example.net", p).allowed).toBe(false);
    // A genuine send from the provider passes SPF as well.
    expect(run(ar("shared.example.net", "pass", "owner@shared.example.net"), "owner@shared.example.net", p).allowed).toBe(true);
  });

  it("accepts a signing domain that is the parent of the envelope domain, but not the reverse", () => {
    expect(run(ar("example.com", "pass", "u@mail.example.com"), "u@mail.example.com", { allowedSenders: ["u@mail.example.com"] }).allowed).toBe(true);
    const p = { allowedSenders: ["u@example.com"], allowedDkimDomains: ["mail.example.com"] };
    expect(run(ar("mail.example.com", "pass", "u@example.com"), "u@example.com", p).allowed).toBe(false);
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
