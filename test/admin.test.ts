import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLane } from "../src/core/lanes";
import { resetAccessCache } from "../src/worker/admin/access";
import worker from "../src/worker/index";
import { AUD, makeKey, signJwt, stubAccessKeys, TEAM, type TestKey } from "./helpers/access";
import { freshDb } from "./helpers/db";
import { testEnv } from "./helpers/mail";

const ADMIN = "https://admin.example.com";
const assetsFetch = vi.fn(async () => new Response("<!doctype html><title>app</title>", { headers: { "content-type": "text/html" } }));

const adminEnv = (overrides: Record<string, unknown> = {}) =>
  testEnv({
    ADMIN_HOSTNAME: "admin.example.com",
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ASSETS: { fetch: assetsFetch },
    ...overrides,
  });

const call = (path: string, init: RequestInit = {}, env = adminEnv(), base = ADMIN) =>
  worker.fetch(new Request(`${base}${path}`, init) as never, env, createExecutionContext());

let key: TestKey;
const signedIn = async (extra: Record<string, string> = {}): Promise<RequestInit> => ({
  headers: { "cf-access-jwt-assertion": await signJwt(key), ...extra },
});

beforeEach(async () => {
  resetAccessCache();
  assetsFetch.mockClear();
  key = await makeKey();
  stubAccessKeys([key]);
  await freshDb();
});

describe("admin host routing", () => {
  it("is not served at all unless ADMIN_HOSTNAME is set", async () => {
    const res = await call("/api/session", await signedIn(), testEnv());
    expect(res.status).toBe(404);
  });

  it("fails closed when the Access settings are missing", async () => {
    for (const missing of [{ ACCESS_TEAM_DOMAIN: undefined }, { ACCESS_AUD: undefined }]) {
      const res = await call("/api/session", await signedIn(), adminEnv(missing));
      expect(res.status).toBe(503);
    }
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it("never lets the admin hostname shadow the MCP or share host", async () => {
    const env = adminEnv({ ADMIN_HOSTNAME: "mcp.example.com" });
    const res = await call("/mcp/agent", { method: "POST" }, env, "https://mcp.example.com");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });
});

describe("admin Access check", () => {
  it("refuses every path without a valid Access token, before touching assets or the API", async () => {
    for (const path of ["/", "/index.html", "/assets/app.js", "/api/session", "/api/lanes", "/api/nothing-here"]) {
      const res = await call(path);
      expect(res.status, path).toBe(403);
      expect(await res.text()).toBe("Forbidden.");
    }
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it("refuses a token for another application", async () => {
    const res = await call("/api/session", { headers: { "cf-access-jwt-assertion": await signJwt(key, { aud: ["other"] }) } });
    expect(res.status).toBe(403);
  });

  it("answers 503 rather than 403 when Access's keys cannot be fetched", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const res = await call("/api/session", await signedIn());
    expect(res.status).toBe(503);
  });

  it("does not trust the Access cookie or a spoofed identity header on its own", async () => {
    const res = await call("/api/session", {
      headers: { cookie: "CF_Authorization=abc", "cf-access-authenticated-user-email": "admin@example.com" },
    });
    expect(res.status).toBe(403);
  });
});

describe("admin API", () => {
  it("returns the session identity", async () => {
    const res = await call("/api/session", await signedIn());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "admin@example.com" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("lists lanes without their address tokens", async () => {
    const db = await freshDb();
    const lane = await createLane(db, { slug: "bills", description: "Monthly bills" });
    const res = await call("/api/lanes", await signedIn());
    const text = await res.text();
    expect(JSON.parse(text)).toEqual([
      { slug: "bills", description: "Monthly bills", status: "active", messageCount: 0, unprocessedCount: 0, lastReceivedAt: null },
    ]);
    expect(text).not.toContain(lane.addressToken);
  });

  it("answers 404 for unknown API paths and 405 for the wrong method", async () => {
    expect((await call("/api/nothing-here", await signedIn())).status).toBe(404);
    const post = await call("/api/session", {
      method: "POST",
      headers: { ...((await signedIn()).headers as object), origin: ADMIN, "content-type": "application/json" },
      body: "{}",
    });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });

  it("refuses changes that are not same-origin JSON", async () => {
    const base = (await signedIn()).headers as Record<string, string>;
    const attempts: Record<string, string>[] = [
      { "content-type": "application/json" },
      { origin: "https://evil.example.net", "content-type": "application/json" },
      { origin: ADMIN, "content-type": "application/x-www-form-urlencoded" },
      { origin: ADMIN, "content-type": "text/plain" },
      { origin: ADMIN },
    ];
    for (const extra of attempts) {
      const res = await call("/api/session", { method: "POST", headers: { ...base, ...extra }, body: "{}" });
      expect(res.status, JSON.stringify(extra)).toBe(403);
    }
  });
});

describe("admin app files", () => {
  it("serves the app from assets once signed in, with security headers", async () => {
    const res = await call("/some/deep/link", await signedIn());
    expect(res.status).toBe(200);
    expect(assetsFetch).toHaveBeenCalledOnce();
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("puts the security headers on API and error responses too", async () => {
    for (const res of [await call("/api/session", await signedIn()), await call("/api/session")]) {
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
  });

  it("refuses non-GET requests for files", async () => {
    const res = await call("/", { method: "POST", ...(await signedIn()) });
    expect(res.status).toBe(405);
  });

  it("answers 503 if the app was not built", async () => {
    const res = await call("/", await signedIn(), adminEnv({ ASSETS: undefined }));
    expect(res.status).toBe(503);
  });
});
