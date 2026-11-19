import { findForwarderResults, parseAuthResults, parseTags, type ParsedAuthResults } from "./arc.ts";
import { isPublicSuffix, isSameOrParent, sameOrganisation } from "./domains.ts";
import { parseHeaders, type Header } from "./headers.ts";
import { EXACT_ADDRESS, findForwardedRule, type ForwardedFromRule } from "./lane-config.ts";

const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net";

export function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

export function normaliseAddress(addr: string | null | undefined): string {
  return (addr ?? "").trim().toLowerCase();
}

/** `Name <a@b.c>` -> `a@b.c`. */
export function extractAddress(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return m ? m[1]! : header;
}

/**
 * The one address in a From header, or null. Accepts `addr` or `Name <addr>` (the name may be a
 * quoted string containing anything); a list of mailboxes, trailing comments and anything else
 * is refused rather than guessed at.
 */
const SINGLE_MAILBOX = /^\s*(?:(?:"(?:[^"\\]|\\.)*"\s*|[^<>@,"]*)<([^<>\s]+)>|([^<>\s,"]+))\s*$/;
export function singleFromAddress(header: string): string | null {
  const m = SINGLE_MAILBOX.exec(header);
  const address = normaliseAddress(m?.[1] ?? m?.[2]);
  return EXACT_ADDRESS.test(address) ? address : null;
}

export interface SenderPolicy {
  allowedSenders: string[];
  /** Path A: domains whose DKIM pass, verified by Cloudflare, is accepted. */
  allowedDkimDomains: string[];
  /** Path B: forwarders (e.g. a mailbox provider) whose ARC record of the original hop is trusted. */
  trustedArcForwarders?: string[];
  /** Path B: original senders this lane accepts, and what must have passed for each. */
  forwardedFrom?: ForwardedFromRule[];
}

export type SenderVerdict =
  | { allowed: true; summary: string; path: "direct" | "forwarded" }
  | {
      allowed: false;
      reason: "sender_not_allowed" | "auth_failed";
      detail: string;
      /** Authentication-header excerpt, only when the envelope sender was allowed. */
      diagnostics?: string;
    };

/**
 * A message is accepted only if its envelope sender is allowlisted AND one of:
 *
 *  A. Cloudflare verified a DKIM signature from an allowlisted domain that matches
 *     the envelope sender's domain, AND an SPF pass for that envelope sender (mail
 *     you compose or forward by hand, signed by your mail provider), or
 *  B. a trusted forwarder's ARC record shows the original sender authenticated
 *     (server-side forwarding rules add no signature of their own).
 *
 * The visible From header is never trusted on its own, and neither are the
 * unsigned hints forwarders add.
 */
export function checkSender(raw: Uint8Array, envelopeFrom: string, policy: SenderPolicy): SenderVerdict {
  if (!policy.allowedSenders.includes(envelopeFrom)) {
    return { allowed: false, reason: "sender_not_allowed", detail: "envelope sender not allowlisted" };
  }

  const headers = parseHeaders(raw);
  const fail = (detail: string): SenderVerdict => ({ allowed: false, reason: "auth_failed", detail, diagnostics: excerpt(headers) });

  const forwardedEnabled = Boolean(policy.forwardedFrom?.length && policy.trustedArcForwarders?.length);
  if (policy.allowedDkimDomains.length === 0 && !forwardedEnabled) return fail("no authentication method configured");

  const results = firstCloudflareAuthResults(headers);
  if (!results) return fail("no Authentication-Results from Cloudflare");

  const detail: string[] = [];
  if (policy.allowedDkimDomains.length) {
    // The signing domain must be the envelope sender's own domain (or its parent), and SPF must
    // vouch for the envelope sender. Without both, a signed message could be replayed from
    // elsewhere, or a signature from an unrelated domain on the list could vouch for anyone.
    const envelopeDomain = domainOf(envelopeFrom);
    const passed = dkimPassDomains(results);
    const accepted = passed.find((d) => policy.allowedDkimDomains.includes(d) && !isPublicSuffix(d) && isSameOrParent(d, envelopeDomain));
    if (accepted && spfPassesFor(results, envelopeFrom)) {
      return { allowed: true, summary: `dkim=pass header.d=${accepted} spf=pass`, path: "direct" };
    }
    detail.push(
      accepted
        ? "direct: dkim passed but there was no spf=pass for the envelope sender"
        : `direct: no dkim=pass aligned with the envelope sender for an allowed domain (passed: ${passed.join(",") || "none"})`,
    );
  }
  if (forwardedEnabled) {
    const forwarded = checkForwarded(headers, results, envelopeFrom, policy.trustedArcForwarders!, policy.forwardedFrom!);
    if (forwarded.ok) return { allowed: true, summary: forwarded.summary, path: "forwarded" };
    detail.push(`forwarded: ${forwarded.detail}`);
  }
  return fail(detail.join("; "));
}

/**
 * Cloudflare prepends its Authentication-Results above any headers the sender
 * supplied, so only the FIRST such header is trusted, and only if Cloudflare is
 * the authserv-id.
 */
function firstCloudflareAuthResults(headers: Header[]): ParsedAuthResults | null {
  const first = headers.find((h) => h.name === "authentication-results");
  if (!first || !first.value.toLowerCase().startsWith(`${CLOUDFLARE_AUTHSERV_ID};`)) return null;
  return parseAuthResults(first.value, false);
}

const dkimPassDomains = (r: ParsedAuthResults) =>
  r.results.filter((x) => x.method === "dkim" && x.result === "pass" && x.props["header.d"]).map((x) => x.props["header.d"]!.toLowerCase());

/** Cloudflare's own SPF result: a pass for exactly this envelope sender. */
const spfPassesFor = (r: ParsedAuthResults, envelopeFrom: string) =>
  r.results.some((x) => x.method === "spf" && x.result === "pass" && x.props["smtp.mailfrom"]?.toLowerCase() === envelopeFrom);

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

type Forwarded = { ok: true; summary: string } | { ok: false; detail: string };

function checkForwarded(
  headers: Header[],
  cloudflare: ParsedAuthResults,
  envelopeFrom: string,
  trusted: string[],
  rules: ForwardedFromRule[],
): Forwarded {
  if (!cloudflare.results.some((r) => r.method === "arc" && r.result === "pass")) {
    return { ok: false, detail: "Cloudflare did not report arc=pass" };
  }
  // The forwarder rewrites the envelope sender to the mailbox owner, and SPF must
  // vouch for it: this stops a genuine ARC-sealed message being replayed from elsewhere.
  if (!spfPassesFor(cloudflare, envelopeFrom)) return { ok: false, detail: "no spf=pass for the envelope sender" };

  const lookup = findForwarderResults(headers, trusted);
  if (!lookup.ok) return lookup;

  const froms = headers.filter((h) => h.name === "from");
  if (froms.length !== 1) return { ok: false, detail: "expected exactly one From header" };
  const fromAddress = singleFromAddress(froms[0]!.value);
  if (!fromAddress) return { ok: false, detail: "From header is not a single address" };
  const rule = findForwardedRule(rules, fromAddress);
  if (!rule) return { ok: false, detail: "From address not accepted on this lane" };
  const fromDomain = domainOf(fromAddress);

  for (const verdict of rule.require) {
    for (const r of lookup.results.results.filter((x) => x.method === verdict && x.result === "pass")) {
      if (verdict === "dmarc" && r.props["header.from"]?.toLowerCase() === fromDomain) {
        return { ok: true, summary: `arc via ${lookup.forwarder}: dmarc=pass header.from=${fromDomain}` };
      }
      if (verdict === "dkim" && r.props["header.d"] && sameOrganisation(r.props["header.d"].toLowerCase(), fromDomain)) {
        return { ok: true, summary: `arc via ${lookup.forwarder}: dkim=pass header.d=${r.props["header.d"].toLowerCase()}` };
      }
      if (verdict === "spf" && r.props["smtp.mailfrom"] && sameOrganisation(domainOf(r.props["smtp.mailfrom"].toLowerCase()), fromDomain)) {
        return { ok: true, summary: `arc via ${lookup.forwarder}: spf=pass aligned with ${fromDomain}` };
      }
    }
  }
  return { ok: false, detail: `forwarder did not record an aligned ${rule.require.join(" or ")} pass` };
}

/**
 * A compact, size-capped view of the authentication headers, for diagnosing
 * why a likely genuine message failed. Headers only: never a body.
 */
function excerpt(headers: Header[]): string {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const lines: string[] = [];
  const first = headers.find((h) => h.name === "authentication-results");
  if (first) lines.push(`first Authentication-Results: ${cut(first.value, 500)}`);
  const seals = headers
    .filter((h) => h.name === "arc-seal")
    .map((h) => parseTags(h.value))
    .map((t) => `i=${t.i} d=${t.d} cv=${t.cv}`);
  if (seals.length) lines.push(`ARC seals: ${seals.join("; ")}`);
  for (const h of headers.filter((x) => x.name === "arc-authentication-results").slice(0, 4)) {
    lines.push(`ARC-Authentication-Results: ${cut(h.value, 400)}`);
  }
  const sigs = headers
    .filter((h) => h.name === "dkim-signature")
    .slice(0, 5)
    .map((h) => parseTags(h.value))
    .map((t) => `d=${t.d} s=${t.s}`);
  if (sigs.length) lines.push(`DKIM signatures: ${sigs.join("; ")}`);
  const froms = headers.filter((h) => h.name === "from");
  lines.push(`From headers: ${froms.length}${froms[0] ? `, domain ${domainOf(normaliseAddress(extractAddress(froms[0].value)))}` : ""}`);
  return cut(lines.join("\n"), 2000);
}

/** The first Authentication-Results value, only if Cloudflare wrote it. Kept for callers that need the raw text. */
export function cloudflareAuthResults(raw: Uint8Array): string | null {
  const first = parseHeaders(raw).find((h) => h.name === "authentication-results");
  return first && first.value.toLowerCase().startsWith(`${CLOUDFLARE_AUTHSERV_ID};`) ? first.value : null;
}
