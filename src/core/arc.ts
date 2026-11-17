import type { Header } from "./headers.ts";

/** Cloudflare seals the ARC chain with its own set on top of whatever arrived. */
export const CLOUDFLARE_ARC_DOMAIN = "cloudflare-email.net";

/** `i=2; d=example.com; cv=pass` -> { i: "2", d: "example.com", cv: "pass" } */
export function parseTags(value: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) tags[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return tags;
}

export interface AuthResult {
  method: string;
  result: string;
  props: Record<string, string>;
}

export interface ParsedAuthResults {
  authserv: string;
  results: AuthResult[];
}

/**
 * Parses an Authentication-Results style value. `instance` is true for
 * ARC-Authentication-Results, which starts with `i=N;`.
 */
export function parseAuthResults(value: string, instance: boolean): ParsedAuthResults | null {
  const parts = value
    .replace(/\([^)]*\)/g, " ")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  if (instance && !/^i=\d+$/i.test(parts.shift() ?? "")) return null;
  const authserv = parts.shift()?.split(/\s+/)[0]?.toLowerCase();
  if (!authserv) return null;

  const results: AuthResult[] = [];
  for (const part of parts) {
    const m = /^([a-z0-9-]+)\s*=\s*([a-z0-9-]+)\s*(.*)$/i.exec(part);
    if (!m) continue;
    const props: Record<string, string> = {};
    for (const token of m[3]!.split(/\s+/)) {
      const eq = token.indexOf("=");
      if (eq > 0) props[token.slice(0, eq).toLowerCase()] = token.slice(eq + 1);
    }
    results.push({ method: m[1]!.toLowerCase(), result: m[2]!.toLowerCase(), props });
  }
  return { authserv, results };
}

export type ForwarderLookup =
  | { ok: true; forwarder: string; results: ParsedAuthResults }
  | { ok: false; detail: string };

/**
 * Finds the ARC set just beneath Cloudflare's own and returns the original
 * hop's recorded verdicts, if a trusted forwarder sealed it. Sets are matched
 * by their `i=` instance, never by header order. The chain's cryptography is
 * not re-checked here: the caller requires Cloudflare's own `arc=pass`, which
 * covers every set including the contents of the forwarder's results.
 */
export function findForwarderResults(headers: Header[], trusted: string[]): ForwarderLookup {
  const seals = new Map<number, { d: string; cv: string }>();
  for (const h of headers.filter((x) => x.name === "arc-seal")) {
    const tags = parseTags(h.value);
    const i = /^\d{1,3}$/.test(tags.i ?? "") ? Number(tags.i) : NaN;
    if (!Number.isInteger(i) || i < 1) return { ok: false, detail: "malformed ARC seal" };
    if (seals.has(i)) return { ok: false, detail: "duplicate ARC instance" };
    seals.set(i, { d: (tags.d ?? "").toLowerCase(), cv: (tags.cv ?? "").toLowerCase() });
  }
  const top = seals.size;
  if (top < 2) return { ok: false, detail: "no forwarder ARC set" };
  for (let i = 1; i <= top; i++) if (!seals.has(i)) return { ok: false, detail: "ARC instances are not contiguous" };

  if (seals.get(top)!.d !== CLOUDFLARE_ARC_DOMAIN) return { ok: false, detail: "top ARC set is not Cloudflare's" };
  const forwarder = seals.get(top - 1)!;
  if (!trusted.includes(forwarder.d)) return { ok: false, detail: "ARC set not sealed by a trusted forwarder" };
  if (forwarder.cv !== "pass") return { ok: false, detail: "forwarder's ARC set did not validate" };

  const aars = headers.filter((h) => h.name === "arc-authentication-results" && parseTags(h.value).i === String(top - 1));
  if (aars.length !== 1) return { ok: false, detail: "expected exactly one ARC-Authentication-Results for the forwarder" };
  const results = parseAuthResults(aars[0]!.value, true);
  if (!results) return { ok: false, detail: "malformed ARC-Authentication-Results" };
  // The results must be recorded by the forwarder's own server, not just sealed by it.
  if (results.authserv !== forwarder.d && !results.authserv.endsWith(`.${forwarder.d}`)) {
    return { ok: false, detail: "ARC results were not recorded by the forwarder" };
  }
  return { ok: true, forwarder: forwarder.d, results };
}
