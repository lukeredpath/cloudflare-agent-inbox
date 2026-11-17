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

export interface SenderPolicy {
  allowedSenders: string[];
  allowedDkimDomains: string[];
}

export type SenderVerdict =
  | { allowed: true; summary: string }
  | { allowed: false; reason: "sender_not_allowed" | "auth_failed"; detail: string };

/**
 * Accept only if the envelope sender is allowlisted AND Cloudflare verified a
 * DKIM signature from an allowlisted domain. The visible From header is never
 * trusted on its own.
 */
export function checkSender(raw: Uint8Array, envelopeFrom: string, policy: SenderPolicy): SenderVerdict {
  if (!policy.allowedSenders.includes(envelopeFrom)) {
    return { allowed: false, reason: "sender_not_allowed", detail: "envelope sender not allowlisted" };
  }
  if (policy.allowedDkimDomains.length === 0) {
    return { allowed: false, reason: "auth_failed", detail: "no DKIM domains configured" };
  }

  const results = cloudflareAuthResults(raw);
  if (!results) return { allowed: false, reason: "auth_failed", detail: "no Authentication-Results from Cloudflare" };

  const passed = [...results.matchAll(/\bdkim=pass\b[^;]*?\bheader\.d=([^\s;]+)/gi)].map((m) => m[1]!.toLowerCase());
  const accepted = passed.find((d) => policy.allowedDkimDomains.includes(d));
  if (!accepted) {
    return {
      allowed: false,
      reason: "auth_failed",
      detail: `no dkim=pass for an allowed domain (passed: ${passed.join(",") || "none"})`,
    };
  }
  return { allowed: true, summary: `dkim=pass header.d=${accepted}` };
}

/**
 * Cloudflare prepends its Authentication-Results above any headers the sender
 * supplied, so only the FIRST such header is trusted, and only if Cloudflare is
 * the authserv-id.
 */
export function cloudflareAuthResults(raw: Uint8Array): string | null {
  const text = new TextDecoder().decode(raw.subarray(0, Math.min(raw.byteLength, 65536)));
  const headerBlock = text.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^authentication-results:\s*(.*)$/i);
    if (!m) continue;
    const value = m[1]!.trim();
    return value.toLowerCase().startsWith(CLOUDFLARE_AUTHSERV_ID + ";") ? value : null;
  }
  return null;
}
