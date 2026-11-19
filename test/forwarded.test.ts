import { beforeEach, describe, expect, it } from "vitest";
import { findForwarderResults, parseAuthResults, parseTags } from "../src/core/arc";
import { checkSender, type SenderPolicy } from "../src/core/check-sender";
import type { Db } from "../src/core/db";
import { LaneInput, LanePatch, MAX_FORWARDED_RULES } from "../src/core/lane-config";
import { parseHeaders } from "../src/core/headers";
import { createLane, getLaneBySlug, updateLane, type Lane } from "../src/core/lanes";
import { handleEmail } from "../src/worker/email";
import { AUTH_PASS, FORWARDED_ORIGIN, arcLines, buildEml, type ArcOptions } from "./helpers/eml";
import { freshDb } from "./helpers/db";
import { laneAddress, makeMessage, testEnv } from "./helpers/mail";

const policy: SenderPolicy = {
  allowedSenders: ["sender@example.com"],
  allowedDkimDomains: ["example.com"],
  trustedArcForwarders: ["forwarder.example.net"],
  forwardedFrom: [{ from: "billing@billing.example.org", require: ["dmarc"] }],
};

const forwarded = (arc: ArcOptions = {}, eml: Parameters<typeof buildEml>[0] = {}) =>
  buildEml({ from: FORWARDED_ORIGIN.from, auth: arcLines(arc), ...eml });
const check = (raw: Uint8Array, p: Partial<SenderPolicy> = {}, envelope = "sender@example.com") =>
  checkSender(raw, envelope, { ...policy, ...p });

describe("path B: mail forwarded by a trusted forwarder", () => {
  it("accepts when the forwarder recorded an aligned dmarc pass for an allowed From address", () => {
    expect(check(forwarded())).toEqual({
      allowed: true,
      summary: "arc via forwarder.example.net: dmarc=pass header.from=billing.example.org",
      path: "forwarded",
    });
  });

  it("matches ARC sets by instance, not by header order", () => {
    const lines = arcLines();
    const [cf, ...arc] = lines;
    const shuffled = [cf!, ...arc.slice().reverse()];
    expect(check(buildEml({ from: FORWARDED_ORIGIN.from, auth: shuffled })).allowed).toBe(true);
  });

  describe("is not tied to any one provider", () => {
    it("accepts a forwarder whose server name has nothing to do with its seal domain, with a version token", () => {
      const raw = forwarded({ forwarder: "mailhost.example.org", forwarderServer: "mx.somewhere-else.example.net 1" });
      expect(check(raw, { trustedArcForwarders: ["mailhost.example.org"] })).toEqual({
        allowed: true,
        summary: "arc via mailhost.example.org: dmarc=pass header.from=billing.example.org",
        path: "forwarded",
      });
    });

    it("trusts several forwarders independently, and names the one that vouched", () => {
      const trusted = ["first.example.net", "second.example.org"];
      expect(check(forwarded({ forwarder: "second.example.org" }), { trustedArcForwarders: trusted })).toMatchObject({
        allowed: true,
        summary: expect.stringContaining("second.example.org"),
      });
      expect(check(forwarded({ forwarder: "first.example.net" }), { trustedArcForwarders: trusted }).allowed).toBe(true);
      expect(check(forwarded({ forwarder: "third.example.com" }), { trustedArcForwarders: trusted }).allowed).toBe(false);
    });

    it("depends on nothing but the configured forwarder list: an empty list turns the path off", () => {
      expect(check(forwarded(), { trustedArcForwarders: [] }).allowed).toBe(false);
    });
  });

  it("ignores unsigned forwarder hints entirely", () => {
    const noHints = arcLines().filter((l) => !/^(X-Forward-Action|Original-Recipient)/.test(l));
    expect(check(buildEml({ from: FORWARDED_ORIGIN.from, auth: noHints })).allowed).toBe(true);
    const lying = arcLines({ extra: ["X-Forward-Action: FORWARD/anything", "Original-Recipient: rfc822;attacker@example.org"] });
    expect(check(buildEml({ from: FORWARDED_ORIGIN.from, auth: lying })).allowed).toBe(true);
  });

  describe("fails closed", () => {
    const rejects = (raw: Uint8Array, detail: RegExp, p: Partial<SenderPolicy> = {}, envelope?: string) => {
      const v = check(raw, p, envelope);
      expect(v).toMatchObject({ allowed: false, reason: "auth_failed" });
      expect((v as { detail: string }).detail).toMatch(detail);
    };

    it("without Cloudflare's arc=pass", () => {
      const cf = "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=billing.example.org; spf=pass smtp.mailfrom=sender@example.com; arc=fail";
      rejects(forwarded({ cloudflare: cf }), /did not report arc=pass/);
    });

    it("when the first Authentication-Results is not Cloudflare's, even if a lower one says arc=pass", () => {
      const lines = [
        "Authentication-Results: evil.example; arc=pass; spf=pass smtp.mailfrom=sender@example.com",
        ...arcLines(),
      ];
      expect(check(buildEml({ from: FORWARDED_ORIGIN.from, auth: lines })).allowed).toBe(false);
    });

    it("without an spf pass for the envelope sender (a replayed message)", () => {
      const cf = "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=billing.example.org; spf=fail smtp.mailfrom=sender@example.com; arc=pass";
      rejects(forwarded({ cloudflare: cf }), /no spf=pass for the envelope sender/);
      const other = "Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=someone@example.org; arc=pass";
      rejects(forwarded({ cloudflare: other }), /no spf=pass/);
    });

    it("when the forwarder is not trusted", () => {
      rejects(forwarded({ forwarder: "other.example.net" }), /not sealed by a trusted forwarder/);
      rejects(forwarded(), /not sealed by a trusted forwarder/, { trustedArcForwarders: ["different.example.net"] });
    });

    it("when the top ARC set is not Cloudflare's", () => {
      rejects(forwarded({ topSeal: "attacker.example.org" }), /top ARC set is not Cloudflare's/);
    });

    it("when the forwarder's own set did not validate", () => {
      rejects(forwarded({ forwarderCv: "fail" }), /did not validate/);
    });

    it("when instances are duplicated, missing, or malformed", () => {
      const lines = arcLines();
      rejects(buildEml({ from: FORWARDED_ORIGIN.from, auth: [...lines, "ARC-Seal: i=2; d=forwarder.example.net; cv=pass"] }), /duplicate ARC instance/);
      const gap = lines.filter((l) => !/^ARC-(Seal|Message-Signature|Authentication-Results): i=1;/.test(l));
      rejects(buildEml({ from: FORWARDED_ORIGIN.from, auth: gap }), /not contiguous/);
      rejects(buildEml({ from: FORWARDED_ORIGIN.from, auth: [lines[0]!, "ARC-Seal: d=x; cv=pass"] }), /malformed ARC seal/);
      rejects(buildEml({ from: FORWARDED_ORIGIN.from, auth: [lines[0]!] }), /no forwarder ARC set/);
      const dupAar = [...lines, "ARC-Authentication-Results: i=2; arc.forwarder.example.net; dmarc=pass header.from=billing.example.org"];
      rejects(buildEml({ from: FORWARDED_ORIGIN.from, auth: dupAar }), /exactly one ARC-Authentication-Results/);
    });

    it("without a recorded pass, or with a pass about a different From domain", () => {
      rejects(forwarded({ recorded: "arc=pass; dmarc=fail header.from=billing.example.org" }), /did not record an aligned dmarc pass/);
      rejects(forwarded({ recorded: "arc=pass; dmarc=none header.from=billing.example.org" }), /did not record/);
      rejects(forwarded({ recorded: "arc=pass; dmarc=pass header.from=other.example.org" }), /did not record/);
      rejects(forwarded({ recorded: "arc=pass; spf=pass smtp.mailfrom=bounce@mail.billing.example.org" }), /did not record/);
    });

    it("for a From address the lane does not accept, or no rules at all", () => {
      rejects(buildEml({ from: "someone@billing.example.org", auth: arcLines() }), /From address not accepted/);
      rejects(forwarded(), /direct: no dkim=pass/, { forwardedFrom: [] });
    });

    it("with several From headers", () => {
      const raw = new TextDecoder().decode(forwarded()).replace("Subject:", "From: other@billing.example.org\r\nSubject:");
      rejects(new TextEncoder().encode(raw), /exactly one From header/);
    });

    it("when the envelope sender is not allowed, whatever the ARC record says", () => {
      expect(check(forwarded(), {}, "attacker@example.org")).toMatchObject({ allowed: false, reason: "sender_not_allowed" });
    });

    it("when no forwarder is trusted, or no authentication method is configured", () => {
      rejects(forwarded(), /direct: no dkim=pass/, { trustedArcForwarders: [] });
      rejects(forwarded(), /no authentication method configured/, { trustedArcForwarders: [], allowedDkimDomains: [] });
    });
  });

  describe("verdicts a rule can require (any of)", () => {
    const rule = (require: ("dmarc" | "dkim" | "spf")[]) => ({ forwardedFrom: [{ from: "billing@billing.example.org", require }] });

    it("dkim must be aligned with the From domain", () => {
      const ok = forwarded({ recorded: "arc=pass; dkim=pass header.d=billing.example.org; dmarc=fail header.from=billing.example.org" });
      expect(check(ok, rule(["dkim"])).allowed).toBe(true);
      expect(check(ok, rule(["dmarc"])).allowed).toBe(false);
      const unaligned = forwarded({ recorded: "arc=pass; dkim=pass header.d=signer.example.net" });
      expect(check(unaligned, rule(["dkim"])).allowed).toBe(false);
      const parent = forwarded({ recorded: "arc=pass; dkim=pass header.d=example.org" });
      expect(check(parent, rule(["dkim"])).allowed).toBe(true);
    });

    it("spf must be aligned with the From domain", () => {
      const ok = forwarded({ recorded: "arc=pass; spf=pass smtp.mailfrom=bounce@mail.billing.example.org" });
      expect(check(ok, rule(["spf"])).allowed).toBe(true);
      const unaligned = forwarded({ recorded: "arc=pass; spf=pass smtp.mailfrom=bounce@esp.example.net" });
      expect(check(unaligned, rule(["spf"])).allowed).toBe(false);
    });

    it("accepts the first satisfied of several", () => {
      const raw = forwarded({ recorded: "arc=pass; dmarc=fail header.from=billing.example.org; spf=pass smtp.mailfrom=b@billing.example.org" });
      expect(check(raw, rule(["dmarc", "spf"])).allowed).toBe(true);
      expect(check(raw, rule(["dmarc"])).allowed).toBe(false);
    });
  });

  it("path A still works unchanged, with or without forwarded rules", () => {
    const manual = buildEml({ auth: [AUTH_PASS()] });
    expect(check(manual).allowed).toBe(true);
    expect(check(manual, { forwardedFrom: [], trustedArcForwarders: [] }).allowed).toBe(true);
  });
});

describe("diagnostics", () => {
  it("are an auth-header excerpt, only when the envelope sender was allowed", () => {
    const v = check(forwarded({ recorded: "arc=pass; dmarc=fail header.from=billing.example.org" }), {}, "sender@example.com");
    expect(v).toMatchObject({ allowed: false });
    const d = (v as { diagnostics: string }).diagnostics;
    expect(d).toContain("first Authentication-Results: mx.cloudflare.net");
    expect(d).toContain("ARC seals: i=3 d=cloudflare-email.net cv=pass; i=2 d=forwarder.example.net cv=pass; i=1 d=origin.example.org cv=none");
    expect(d).toContain("ARC-Authentication-Results: i=2; arc.forwarder.example.net; arc=pass; dmarc=fail");
    expect(d).toContain("domain billing.example.org");
    expect(d.length).toBeLessThanOrEqual(2000);

    const spoof = check(forwarded(), {}, "attacker@example.org") as { diagnostics?: string };
    expect(spoof.diagnostics).toBeUndefined();
  });

  it("never include the message body", () => {
    const v = check(forwarded({ cloudflare: "Authentication-Results: mx.cloudflare.net; arc=fail" }, { text: "SECRET BODY CONTENT" }));
    expect((v as { diagnostics: string }).diagnostics).not.toContain("SECRET BODY CONTENT");
  });

  it("are capped however long the headers are", () => {
    const long = "x".repeat(5000);
    const v = check(buildEml({ auth: [`Authentication-Results: mx.cloudflare.net; dkim=none; note=${long}`] }));
    expect((v as { diagnostics: string }).diagnostics.length).toBeLessThanOrEqual(2000);
  });
});

describe("parsing helpers", () => {
  it("parses tags and results, dropping comments", () => {
    expect(parseTags("i=2; d=Example.com; cv=pass")).toEqual({ i: "2", d: "Example.com", cv: "pass" });
    const r = parseAuthResults("i=2; arc.example.com; arc=pass; dmarc=pass (p=none) header.from=a.example; spf=pass smtp.mailfrom=u@a.example", true)!;
    expect(r.authserv).toBe("arc.example.com");
    expect(r.results.map((x) => `${x.method}:${x.result}`)).toEqual(["arc:pass", "dmarc:pass", "spf:pass"]);
    expect(r.results[1]!.props["header.from"]).toBe("a.example");
    expect(parseAuthResults("garbage", true)).toBeNull();
  });

  it("unfolds and lower-cases headers", () => {
    const h = parseHeaders(new TextEncoder().encode("Subject: a\r\n b\r\nX-Y:  z \r\n\r\nbody: not a header"));
    expect(h).toEqual([{ name: "subject", value: "a b" }, { name: "x-y", value: "z" }]);
  });

  it("finds nothing without a chain", () => {
    expect(findForwarderResults(parseHeaders(new TextEncoder().encode("A: b\r\n\r\n")), ["x"])).toMatchObject({ ok: false });
  });
});

describe("end to end", () => {
  let db: Db;
  let lane: Lane;
  beforeEach(async () => {
    db = await freshDb();
    lane = await createLane(db, { slug: "invoices", forwarded_from: [{ from: "billing@billing.example.org", require: ["dmarc"] }] });
  });
  const deliver = async (raw: Uint8Array, env: Record<string, unknown> = {}) => {
    const message = makeMessage(raw, { to: laneAddress(lane) });
    await handleEmail(message, testEnv(env));
    return message;
  };
  const rows = () => db.all<{ subject: string; auth_summary: string; original_from: string | null }>("SELECT subject, auth_summary, original_from FROM messages");
  const rejections = () => db.all<{ reason: string; detail: string; diagnostics: string | null }>("SELECT reason, detail, diagnostics FROM rejections");

  it("stores an ARC-forwarded message with its auth summary, and strips the scan tag from the subject", async () => {
    const message = await deliver(forwarded({}, { subject: "[Not Virus Scanned] Your bill is available." }));
    expect(message.rejected).toBeNull();
    expect(await rows()).toEqual([
      { subject: "Your bill is available.", auth_summary: "arc via forwarder.example.net: dmarc=pass header.from=billing.example.org", original_from: null },
    ]);
  });

  it("only strips a leading scan tag", async () => {
    await deliver(forwarded({}, { subject: "Re: [Not Virus Scanned] hello" }));
    expect((await rows())[0]!.subject).toBe("Re: [Not Virus Scanned] hello");
  });

  it("logs a failed forward with a diagnostics excerpt, and nothing else about the message", async () => {
    const message = await deliver(forwarded({ recorded: "arc=pass; dmarc=fail header.from=billing.example.org" }, { text: "PRIVATE BODY" }));
    expect(message.rejected).toBeNull();
    expect(await rows()).toHaveLength(0);
    const [r] = await rejections();
    expect(r).toMatchObject({ reason: "auth_failed" });
    expect(r!.detail).toContain("forwarded: forwarder did not record an aligned dmarc pass");
    expect(r!.diagnostics).toContain("ARC seals:");
    expect(JSON.stringify(r)).not.toContain("PRIVATE BODY");
  });

  it("keeps no diagnostics for a sender that is not allowed", async () => {
    const message = makeMessage(forwarded(), { from: "attacker@example.org", to: laneAddress(lane) });
    await handleEmail(message, testEnv());
    expect(await rejections()).toMatchObject([{ reason: "sender_not_allowed", diagnostics: null }]);
  });

  it("a lane without forwarded rules rejects the same message", async () => {
    await updateLane(db, lane.id, { forwarded_from: [] });
    await deliver(forwarded());
    expect(await rows()).toHaveLength(0);
    expect((await rejections())[0]!.detail).toMatch(/^direct:/);
  });

  it("is off deployment-wide when no forwarder is trusted", async () => {
    await deliver(forwarded(), { TRUSTED_ARC_FORWARDERS: "" });
    expect(await rows()).toHaveLength(0);
  });

  it("lane config round-trips and patches without disturbing other fields", async () => {
    const updated = await updateLane(db, lane.id, { description: "changed" });
    expect(updated.forwardedFrom).toEqual([{ from: "billing@billing.example.org", require: ["dmarc"] }]);
    const cleared = await updateLane(db, lane.id, { forwarded_from: [] });
    expect(cleared.forwardedFrom).toEqual([]);
    expect((await getLaneBySlug(db, "invoices"))!.forwardedFrom).toEqual([]);
    await expect(updateLane(db, lane.id, { forwarded_from: [{ from: "not-an-address", require: ["dmarc"] }] })).rejects.toThrow();
    await expect(updateLane(db, lane.id, { forwarded_from: [{ from: "a@example.org", require: [] }] })).rejects.toThrow();
  });
});

describe("domain alignment is organisation-aware (R9)", () => {
  const rule = (require: ("dmarc" | "dkim" | "spf")[], from = "billing@billing.example.org") => ({ forwardedFrom: [{ from, require }] });

  it("two different sites on a shared hosting suffix are not aligned", () => {
    const from = "owner@owner.github.io";
    const attacker = forwarded({ recorded: "arc=pass; dkim=pass header.d=attacker.github.io" }, {});
    const raw = new TextDecoder().decode(attacker).replace("billing@billing.example.org", from);
    expect(check(new TextEncoder().encode(raw), rule(["dkim"], from)).allowed).toBe(false);
    // The same site signing for itself is fine.
    const own = new TextDecoder().decode(forwarded({ recorded: "arc=pass; dkim=pass header.d=owner.github.io" })).replace("billing@billing.example.org", from);
    expect(check(new TextEncoder().encode(own), rule(["dkim"], from)).allowed).toBe(true);
  });

  it("a signature from a bare public suffix never aligns", () => {
    const raw = new TextDecoder().decode(forwarded({ recorded: "arc=pass; dkim=pass header.d=co.uk" })).replace("billing@billing.example.org", "a@shop.co.uk");
    expect(check(new TextEncoder().encode(raw), rule(["dkim"], "a@shop.co.uk")).allowed).toBe(false);
  });

  it("sibling subdomains of one organisation still align, for dkim and spf", () => {
    const dkim = forwarded({ recorded: "arc=pass; dkim=pass header.d=mail.example.org" });
    expect(check(dkim, rule(["dkim"])).allowed).toBe(true);
    const spf = forwarded({ recorded: "arc=pass; spf=pass smtp.mailfrom=bounce@esp.example.org" });
    expect(check(spf, rule(["spf"])).allowed).toBe(true);
  });

  it("path A will not accept a public suffix as the signing domain", () => {
    const raw = buildEml({ auth: ["Authentication-Results: mx.cloudflare.net; dkim=pass header.d=co.uk; spf=pass smtp.mailfrom=u@a.co.uk"] });
    const v = checkSender(raw, "u@a.co.uk", { allowedSenders: ["u@a.co.uk"], allowedDkimDomains: ["co.uk"] });
    expect(v.allowed).toBe(false);
  });
});

describe("domain helpers", () => {
  it("knows public suffixes and organisations", async () => {
    const { isPublicSuffix, sameOrganisation, isSameOrParent } = await import("../src/core/domains");
    expect(isPublicSuffix("com")).toBe(true);
    expect(isPublicSuffix("co.uk")).toBe(true);
    expect(isPublicSuffix("example.co.uk")).toBe(false);
    expect(sameOrganisation("a.example.com", "b.example.com")).toBe(true);
    expect(sameOrganisation("a.github.io", "b.github.io")).toBe(false);
    expect(sameOrganisation("evil.co.uk", "good.co.uk")).toBe(false);
    expect(sameOrganisation("example.com", "example.org")).toBe(false);
    expect(isSameOrParent("example.com", "mail.example.com")).toBe(true);
    expect(isSameOrParent("mail.example.com", "example.com")).toBe(false);
  });
});

describe("a forwarder that is the first ARC hop (i=1, cv=none)", () => {
  const first = (arc: ArcOptions = {}, eml: Parameters<typeof buildEml>[0] = {}) => forwarded({ firstHop: true, ...arc }, eml);

  it("is accepted: the first set of a chain has nothing to validate", () => {
    expect(check(first())).toMatchObject({ allowed: true, path: "forwarded" });
  });

  it("is refused when Cloudflare's own set did not validate", () => {
    expect(check(first({ topCv: "fail" }))).toMatchObject({ allowed: false, detail: expect.stringContaining("Cloudflare's ARC set did not validate") });
    expect(check(forwarded({ topCv: "none" }))).toMatchObject({ allowed: false });
  });

  it("is refused when the forwarder's set failed, or says none while not first", () => {
    expect(check(first({ forwarderCv: "fail" })).allowed).toBe(false);
    expect(check(forwarded({ forwarderCv: "none" }))).toMatchObject({ allowed: false, detail: expect.stringContaining("did not validate") });
  });
});

describe("wildcard forwarded_from rules", () => {
  const WILD: { from: string; require: ("dmarc" | "dkim" | "spf")[] }[] = [{ from: "*", require: ["dmarc"] }];
  const rules = (...r: { from: string; require: ("dmarc" | "dkim" | "spf")[] }[]) => ({ forwardedFrom: r });
  const dmarcFor = (domain: string) => `arc=pass; dmarc=pass header.from=${domain}`;
  const from = (address: string, recordedDomain: string, arc: ArcOptions = {}) =>
    forwarded({ firstHop: true, recorded: dmarcFor(recordedDomain), ...arc }, { from: address });

  it("`*` accepts any From domain the forwarder recorded an aligned dmarc pass for", () => {
    expect(check(from("a@anything.example.com", "anything.example.com"), { forwardedFrom: [...WILD] })).toMatchObject({
      allowed: true,
      summary: "arc via forwarder.example.net: dmarc=pass header.from=anything.example.com",
    });
  });

  it("`*@domain` matches exactly that domain, not another TLD or a subdomain", () => {
    const p = rules({ from: "*@shop.example.co.uk", require: ["dmarc"] });
    expect(check(from("orders@shop.example.co.uk", "shop.example.co.uk"), p).allowed).toBe(true);
    expect(check(from("x@shop.example.com", "shop.example.com"), p)).toMatchObject({ allowed: false, detail: expect.stringContaining("not accepted") });
    expect(check(from("x@sub.shop.example.co.uk", "sub.shop.example.co.uk"), p).allowed).toBe(false);
    expect(check(from("x@SHOP.EXAMPLE.CO.UK", "shop.example.co.uk"), p).allowed).toBe(true);
  });

  it("an exact rule wins over a domain rule, which wins over `*`, and only that rule is tried", () => {
    const p = rules(
      { from: "*", require: ["dmarc"] },
      { from: "*@shop.example.net", require: ["dmarc"] },
      { from: "orders@shop.example.net", require: ["spf"] },
    );
    // The exact rule needs spf; the recorded dmarc pass would satisfy the others, but must not fall through.
    expect(check(from("orders@shop.example.net", "shop.example.net"), p)).toMatchObject({
      allowed: false,
      detail: expect.stringContaining("aligned spf pass"),
    });
    expect(check(from("other@shop.example.net", "shop.example.net"), p).allowed).toBe(true);
    // A failing domain rule does not fall back to `*` either.
    expect(check(from("x@shop.example.net", "elsewhere.example.org"), p).allowed).toBe(false);
    expect(check(from("x@unlisted.example.org", "unlisted.example.org"), p).allowed).toBe(true);
  });

  /** A message whose From header is exactly `header`, recorded as dmarc-aligned with `domain`. */
  const rawFrom = (header: string, domain: string) =>
    new TextEncoder().encode(
      new TextDecoder().decode(from("a@x.example.com", domain)).replace(/^From: .*$/m, `From: ${header}`),
    );

  describe("under `*`, spoofs are still rejected", () => {
    const p = { forwardedFrom: [...WILD] };
    it("arc failure", () => {
      const cf = "Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=sender@example.com; arc=fail";
      expect(check(from("a@x.example.com", "x.example.com", { cloudflare: cf }), p).allowed).toBe(false);
    });
    it("spf failure for the envelope sender", () => {
      const cf = "Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom=sender@example.com; arc=pass";
      expect(check(from("a@x.example.com", "x.example.com", { cloudflare: cf }), p).allowed).toBe(false);
    });
    it("a dmarc pass aligned with a different domain than the From", () => {
      expect(check(from("a@x.example.com", "other.example.org"), p).allowed).toBe(false);
    });
    it("a dkim or spf pass without dmarc", () => {
      expect(check(from("a@x.example.com", "x.example.com", { recorded: "arc=pass; dkim=pass header.d=x.example.com; spf=pass smtp.mailfrom=a@x.example.com" }), p).allowed).toBe(false);
    });
    it("an untrusted forwarder", () => {
      expect(check(from("a@x.example.com", "x.example.com", { forwarder: "other.example.net" }), p).allowed).toBe(false);
    });
    it("a display name hiding another address", () => {
      const raw = rawFrom('"x <a@x.example.com>" <evil@evil.example.org>', "x.example.com");
      expect(check(raw, p).allowed).toBe(false);
      expect(check(rawFrom('"x <a@x.example.com>" <a@x.example.com>', "x.example.com"), p).allowed).toBe(true);
    });
    it("a list of mailboxes, or a trailing comment", () => {
      expect(check(rawFrom("a@x.example.com, b@y.example.org", "y.example.org"), p)).toMatchObject({ detail: expect.stringContaining("not a single address") });
      expect(check(rawFrom("a@x.example.com (b@y.example.org)", "x.example.com"), p)).toMatchObject({ detail: expect.stringContaining("not a single address") });
      expect(check(rawFrom('"A" <a@x.example.com>, "B" <b@y.example.org>', "y.example.org"), p).allowed).toBe(false);
    });
  });

  it("accepts a quoted display name containing a comma", () => {
    expect(check(rawFrom('"Shop, Inc." <orders@x.example.com>', "x.example.com"), { forwardedFrom: [...WILD] }).allowed).toBe(true);
  });
});

describe("forwarded rule validation", () => {
  const parse = (forwarded_from: unknown) => LanePatch.safeParse({ forwarded_from });
  const ok = (forwarded_from: unknown) => expect(parse(forwarded_from).success).toBe(true);
  const bad = (forwarded_from: unknown) => expect(parse(forwarded_from).success).toBe(false);

  it("accepts an address, a domain wildcard and `*`, each with dmarc only for the wildcards", () => {
    ok([{ from: "a@example.com", require: ["spf"] }]);
    ok([{ from: "*@Example.co.uk", require: ["dmarc"] }]);
    ok([{ from: "*", require: ["dmarc"] }]);
    expect(LanePatch.parse({ forwarded_from: [{ from: "*@Example.co.uk" }] }).forwarded_from).toEqual([{ from: "*@example.co.uk", require: ["dmarc"] }]);
  });

  it("refuses a wildcard that requires anything but dmarc", () => {
    bad([{ from: "*", require: ["dkim"] }]);
    bad([{ from: "*", require: ["dmarc", "spf"] }]);
    bad([{ from: "*@example.co.uk", require: ["spf"] }]);
    bad([{ from: "*@example.co.uk", require: ["dmarc", "dkim"] }]);
  });

  it("refuses malformed wildcards, and a public suffix", () => {
    for (const from of ["*@", "foo*@example.com", "*.example.com", "*@*.example.com", "**", "*@example", "*@co.uk", "*@github.io", "a@b*.example.com"]) {
      bad([{ from, require: ["dmarc"] }]);
    }
  });

  it("refuses duplicate patterns, and more than the maximum number of rules, for both creation and patching", () => {
    bad([{ from: "*", require: ["dmarc"] }, { from: "*", require: ["dmarc"] }]);
    ok(Array.from({ length: MAX_FORWARDED_RULES }, (_, i) => ({ from: `*@d${i}.example.com`, require: ["dmarc"] })));
    bad(Array.from({ length: MAX_FORWARDED_RULES + 1 }, (_, i) => ({ from: `*@d${i}.example.com`, require: ["dmarc"] })));
    expect(LaneInput.safeParse({ slug: "a", forwarded_from: [{ from: "*", require: ["spf"] }] }).success).toBe(false);
    expect(LaneInput.safeParse({ slug: "a", forwarded_from: [{ from: "*" }] }).success).toBe(true);
  });

  it("a lane with a wildcard round-trips", async () => {
    const db = await freshDb();
    const lane = await createLane(db, { slug: "receipts", forwarded_from: [{ from: "*", require: ["dmarc"] }] });
    expect((await getLaneBySlug(db, lane.slug))!.forwardedFrom).toEqual([{ from: "*", require: ["dmarc"] }]);
  });
});

describe("rules stored by an earlier version", () => {
  const stored = async (rules: unknown) => {
    const db = await freshDb();
    const lane = await createLane(db, { slug: "old" });
    await db.run("UPDATE lanes SET forwarded_from = ? WHERE id = ?", [JSON.stringify(rules), lane.id]);
    return (await getLaneBySlug(db, "old"))!;
  };

  it("are dropped when they no longer validate, and duplicates keep the first", async () => {
    const lane = await stored([
      { from: "*@example.com", require: ["spf"] },
      { from: "foo*@example.com", require: ["dmarc"] },
      { from: "a@example.com", require: ["spf"] },
      { from: "a@example.com", require: ["dkim"] },
      "garbage",
    ]);
    expect(lane.forwardedFrom).toEqual([{ from: "a@example.com", require: ["spf"] }]);
  });

  it("a wildcard is only matched on dmarc even if the stored rule says otherwise", () => {
    const loose = { from: "*", require: ["spf"] } as unknown as { from: string; require: ("dmarc" | "dkim" | "spf")[] };
    const raw = forwarded({ firstHop: true, recorded: "arc=pass; spf=pass smtp.mailfrom=bounce@billing.example.org" });
    expect(check(raw, { forwardedFrom: [loose] })).toMatchObject({ allowed: false, detail: expect.stringContaining("aligned dmarc pass") });
  });
});

describe("findForwarderResults at the first hop", () => {
  const lookup = (arc: ArcOptions, trusted = ["forwarder.example.net"]) =>
    findForwarderResults(parseHeaders(buildEml({ auth: arcLines({ firstHop: true, ...arc }) })), trusted);

  it("accepts a trusted i=1 seal with cv=none, and refuses an untrusted one", () => {
    expect(lookup({})).toMatchObject({ ok: true, forwarder: "forwarder.example.net" });
    expect(lookup({ forwarder: "other.example.net" })).toMatchObject({ ok: false, detail: expect.stringContaining("trusted forwarder") });
  });
});
