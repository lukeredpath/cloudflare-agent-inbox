import { beforeEach, describe, expect, it } from "vitest";
import { resetAccessCache, verifyAccessJwt, type FetchKeys } from "../src/worker/admin/access";
import { AUD, makeKey, signJwt, TEAM } from "./helpers/access";

const config = { teamDomain: TEAM, audience: AUD };

beforeEach(() => resetAccessCache());

async function setup() {
  const key = await makeKey();
  let fetches = 0;
  const fetchKeys: FetchKeys = async () => {
    fetches++;
    return [key.jwk];
  };
  return { key, fetchKeys, fetches: () => fetches };
}

describe("verifyAccessJwt", () => {
  it("accepts a valid token and returns the email", async () => {
    const { key, fetchKeys } = await setup();
    const result = await verifyAccessJwt(await signJwt(key), config, fetchKeys);
    expect(result).toEqual({ ok: true, identity: { email: "admin@example.com" } });
  });

  it("accepts a service token with no email, and a string audience", async () => {
    const { key, fetchKeys } = await setup();
    const token = await signJwt(key, { email: undefined, aud: AUD });
    expect(await verifyAccessJwt(token, config, fetchKeys)).toEqual({ ok: true, identity: { email: null } });
  });

  it("refuses a missing or malformed token", async () => {
    const { key, fetchKeys } = await setup();
    expect(await verifyAccessJwt(null, config, fetchKeys)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyAccessJwt("a.b", config, fetchKeys)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyAccessJwt("a.b.c", config, fetchKeys)).toEqual({ ok: false, reason: "malformed" });
    const token = await signJwt(key);
    expect(await verifyAccessJwt(`${token}.extra`, config, fetchKeys)).toEqual({ ok: false, reason: "malformed" });
  });

  it("never lets the token choose the algorithm", async () => {
    const { key, fetchKeys } = await setup();
    for (const alg of ["none", "HS256", "RS512"]) {
      const result = await verifyAccessJwt(await signJwt(key, {}, { alg }), config, fetchKeys);
      expect(result).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("refuses a token signed by another key, even with a known key id", async () => {
    const { key, fetchKeys } = await setup();
    const other = await makeKey(key.kid);
    expect(await verifyAccessJwt(await signJwt(other), config, fetchKeys)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a tampered payload", async () => {
    const { key, fetchKeys } = await setup();
    const [h, , s] = (await signJwt(key)).split(".");
    const forged = btoa(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], exp: 9_999_999_999 })).replace(/=+$/, "");
    expect(await verifyAccessJwt(`${h}.${forged}.${s}`, config, fetchKeys)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("checks audience, issuer, expiry and not-before", async () => {
    const { key, fetchKeys } = await setup();
    const now = Math.floor(Date.now() / 1000);
    const cases: Record<string, unknown>[] = [
      { aud: ["another-app"] },
      { aud: [] },
      { iss: "https://other.example.com" },
      { exp: now - 3600 },
      { exp: undefined },
      { nbf: now + 3600 },
    ];
    for (const claims of cases) {
      expect(await verifyAccessJwt(await signJwt(key, claims), config, fetchKeys)).toEqual({ ok: false, reason: "bad_claims" });
    }
  });

  it("refuses an unknown key id and does not refetch on demand", async () => {
    const { key, fetchKeys, fetches } = await setup();
    const stranger = await makeKey("rotated");
    expect(await verifyAccessJwt(await signJwt(stranger), config, fetchKeys)).toEqual({ ok: false, reason: "unknown_key" });
    expect(await verifyAccessJwt(await signJwt(stranger), config, fetchKeys)).toEqual({ ok: false, reason: "unknown_key" });
    expect(fetches()).toBe(1);
    // A known key still works from the cache.
    expect((await verifyAccessJwt(await signJwt(key), config, fetchKeys)).ok).toBe(true);
    expect(fetches()).toBe(1);
  });

  it("picks up a rotated key once the throttle has passed", async () => {
    const first = await makeKey("one");
    const second = await makeKey("two");
    let current = [first];
    const fetchKeys: FetchKeys = async () => current.map((k) => k.jwk);
    const t0 = new Date();
    expect((await verifyAccessJwt(await signJwt(first), config, fetchKeys, t0)).ok).toBe(true);
    current = [first, second];
    const later = new Date(t0.getTime() + 2 * 60_000);
    const token = await signJwt(second);
    expect((await verifyAccessJwt(token, config, fetchKeys, later)).ok).toBe(true);
  });

  it("fails closed when the keys cannot be fetched", async () => {
    const { key } = await setup();
    const fetchKeys: FetchKeys = async () => {
      throw new Error("offline");
    };
    expect(await verifyAccessJwt(await signJwt(key), config, fetchKeys)).toEqual({ ok: false, reason: "keys_unavailable" });
  });
});
