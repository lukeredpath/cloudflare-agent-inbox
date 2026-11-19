import { createExecutionContext } from "cloudflare:test";
import { beforeEach } from "vitest";
import { resetAccessCache } from "../../src/worker/admin/access";
import worker from "../../src/worker/index";
import { AUD, makeKey, signJwt, stubAccessKeys, TEAM, type TestKey } from "./access";
import { freshDb } from "./db";
import { testEnv } from "./mail";

export const ADMIN_ORIGIN = "https://admin.example.com";

export const adminEnv = (overrides: Record<string, unknown> = {}) =>
  testEnv({
    ADMIN_HOSTNAME: "admin.example.com",
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ASSETS: { fetch: async () => new Response("<!doctype html>") },
    ...overrides,
  });

export interface ApiResult {
  status: number;
  /** The parsed JSON body, or null when the response was not JSON. */
  body: any;
  res: Response;
}

/** Signed-in calls to the admin API, with the Origin and content type the app itself sends for changes. */
export function useAdminApi() {
  const state: { key?: TestKey } = {};
  beforeEach(async () => {
    resetAccessCache();
    state.key = await makeKey();
    stubAccessKeys([state.key]);
    await freshDb();
  });

  return async function call(method: string, path: string, body?: unknown, env = adminEnv()): Promise<ApiResult> {
    const headers: Record<string, string> = { "cf-access-jwt-assertion": await signJwt(state.key!) };
    if (method !== "GET") {
      headers.origin = ADMIN_ORIGIN;
      headers["content-type"] = "application/json";
    }
    const res = await worker.fetch(
      new Request(`${ADMIN_ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }) as never,
      env,
      createExecutionContext(),
    );
    // Files and error pages are not JSON; leave their bodies unread for the caller.
    const parsed = res.headers.get("content-type")?.includes("application/json") ? await res.clone().json() : null;
    return { status: res.status, body: parsed, res };
  };
}
