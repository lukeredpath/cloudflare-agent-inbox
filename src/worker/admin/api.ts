import { d1Db, type Db } from "../../core/db.ts";
import type { Env } from "../env.ts";
import { logEvent } from "../log.ts";
import type { AccessIdentity } from "./access.ts";
import { fail, failureResponse } from "./http.ts";
import { agentRoutes } from "./routes/agents.ts";
import { ingestKeyRoutes } from "./routes/ingest-keys.ts";
import { laneRoutes } from "./routes/lanes.ts";
import { messageRoutes } from "./routes/messages.ts";
import { rejectionRoutes } from "./routes/rejections.ts";
import { sessionRoutes } from "./routes/session.ts";
import type { Route } from "./routes/route.ts";

const routes: Route[] = [...sessionRoutes, ...laneRoutes, ...ingestKeyRoutes, ...agentRoutes, ...messageRoutes, ...rejectionRoutes];

/**
 * Changes must be JSON sent from the admin app itself. A form on another site cannot send
 * `application/json`, and the browser sets `Origin` itself, so together they stop cross-site requests
 * that ride on the Access cookie.
 */
function isSameOriginJson(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return false;
  return /^application\/json(\s*;|$)/i.test(request.headers.get("content-type") ?? "");
}

export async function handleApi(request: Request, env: Env, identity: AccessIdentity): Promise<Response> {
  const method = request.method.toUpperCase();
  const safe = method === "GET" || method === "HEAD";
  // A change with no body (revoke, rotate) still has to be JSON from our own origin.
  if (!safe && !isSameOriginJson(request)) return fail(403, "forbidden");

  const url = new URL(request.url);
  const matching = routes.filter((r) => r.pattern.test(url.pathname));
  if (matching.length === 0) return fail(404, "not found");
  const route = matching.find((r) => r.method === (method === "HEAD" ? "GET" : method));
  if (!route) return fail(405, "method not allowed", {}, { allow: [...new Set(matching.map((r) => r.method))].join(", ") });

  const db: Db = d1Db(env.DB);
  const params = route.pattern.exec(url.pathname)!.slice(1);
  try {
    const response = await route.handler({ db, env, identity, request, url, params });
    // What was done, never to what: no lane names, addresses or content.
    if (!safe) logEvent("admin", { action: route.name, outcome: response.ok ? "ok" : "refused", status: response.status });
    return response;
  } catch (e) {
    const mapped = failureResponse(e);
    if (mapped) {
      if (!safe) logEvent("admin", { action: route.name, outcome: "refused", status: mapped.status });
      return mapped;
    }
    logEvent("admin", { action: route.name, outcome: "internal_error" }, "error");
    return fail(500, "internal error");
  }
}
