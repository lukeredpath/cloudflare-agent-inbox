/**
 * Verifies the JWT that Cloudflare Access adds to every request it lets through
 * (`Cf-Access-Jwt-Assertion`). The Worker does not decide who may sign in; that is the Access
 * policy. It only refuses requests that did not come through the configured Access application.
 */

export interface AccessConfig {
  /** The team's Access hostname, for example `team.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's audience tag. */
  audience: string;
}

export interface AccessIdentity {
  /** Absent for service tokens. */
  email: string | null;
}

export type AccessFailure = "missing" | "malformed" | "unknown_key" | "bad_signature" | "bad_claims" | "keys_unavailable";
export type AccessResult = { ok: true; identity: AccessIdentity } | { ok: false; reason: AccessFailure };

interface Jwk extends JsonWebKey {
  kid?: string;
}

export type FetchKeys = (teamDomain: string) => Promise<Jwk[]>;

const KEY_TTL_MS = 60 * 60 * 1000;
/** An unknown key id may mean a rotation, but must not let a caller make us refetch on demand. */
const REFETCH_MIN_MS = 60 * 1000;
const LEEWAY_SECONDS = 60;

interface CachedKeys {
  keys: Jwk[];
  fetchedAt: number;
}
const cache = new Map<string, CachedKeys>();

export function resetAccessCache(): void {
  cache.clear();
}

export const fetchAccessKeys: FetchKeys = async (teamDomain) => {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("keys unavailable");
  const body = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new Error("keys unavailable");
  return body.keys;
};

async function keysFor(teamDomain: string, kid: string, fetchKeys: FetchKeys, now: number): Promise<Jwk | null> {
  const cached = cache.get(teamDomain);
  const fresh = cached && now - cached.fetchedAt < KEY_TTL_MS;
  const hit = fresh ? cached.keys.find((k) => k.kid === kid) : undefined;
  if (hit) return hit;
  if (cached && now - cached.fetchedAt < REFETCH_MIN_MS) return null;
  const keys = await fetchKeys(teamDomain);
  cache.set(teamDomain, { keys, fetchedAt: now });
  return keys.find((k) => k.kid === kid) ?? null;
}

function decodeSegment(segment: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "="));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function decodeJson(segment: string): Record<string, unknown> | null {
  const bytes = decodeSegment(segment);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function verifyAccessJwt(
  token: string | null,
  config: AccessConfig,
  fetchKeys: FetchKeys = fetchAccessKeys,
  now: Date = new Date(),
): Promise<AccessResult> {
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeJson(headerPart);
  const payload = decodeJson(payloadPart);
  const signature = decodeSegment(signaturePart);
  if (!header || !payload || !signature) return { ok: false, reason: "malformed" };
  // Pin the algorithm: never let the token choose how it is verified.
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "malformed" };

  let jwk: Jwk | null;
  try {
    jwk = await keysFor(config.teamDomain, header.kid, fetchKeys, now.getTime());
  } catch {
    return { ok: false, reason: "keys_unavailable" };
  }
  if (!jwk || jwk.kty !== "RSA") return { ok: false, reason: "unknown_key" };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  const seconds = Math.floor(now.getTime() / 1000);
  const { iss, aud, exp, nbf, email } = payload;
  const audiences = Array.isArray(aud) ? aud : [aud];
  const claimsOk =
    iss === `https://${config.teamDomain}` &&
    audiences.includes(config.audience) &&
    typeof exp === "number" &&
    exp + LEEWAY_SECONDS > seconds &&
    (nbf === undefined || (typeof nbf === "number" && nbf - LEEWAY_SECONDS <= seconds));
  if (!claimsOk) return { ok: false, reason: "bad_claims" };

  return { ok: true, identity: { email: typeof email === "string" ? email : null } };
}
