import { d1Db, type Db } from "../../core/db.ts";
import { listLanes } from "../../core/lanes.ts";
import type { Env } from "../env.ts";
import type { AccessIdentity } from "./access.ts";
import type { ApiError, LaneListItem, SessionView } from "./types.ts";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const fail = (status: number, error: string, headers?: Record<string, string>) => json(status, { error } satisfies ApiError, headers);

interface ApiContext {
  db: Db;
  identity: AccessIdentity;
  env: Env;
}

type Handler = (request: Request, ctx: ApiContext, params: string[]) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const routes: Route[] = [
  { method: "GET", pattern: /^\/api\/session$/, handler: (_req, ctx) => json(200, { email: ctx.identity.email } satisfies SessionView) },
  {
    method: "GET",
    pattern: /^\/api\/lanes$/,
    // The address token is deliberately absent: it is a secret and has its own endpoint later.
    handler: async (_req, ctx) => {
      const lanes = await listLanes(ctx.db);
      return json(
        200,
        lanes.map(
          (l): LaneListItem => ({
            slug: l.slug,
            description: l.description,
            status: l.status,
            messageCount: l.messageCount,
            unprocessedCount: l.unprocessedCount,
            lastReceivedAt: l.lastReceivedAt,
          }),
        ),
      );
    },
  },
];

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
  if (!safe && !isSameOriginJson(request)) return fail(403, "forbidden");

  const { pathname } = new URL(request.url);
  const matching = routes.filter((r) => r.pattern.test(pathname));
  if (matching.length === 0) return fail(404, "not found");
  const route = matching.find((r) => r.method === (method === "HEAD" ? "GET" : method));
  if (!route) return fail(405, "method not allowed", { allow: matching.map((r) => r.method).join(", ") });

  const params = route.pattern.exec(pathname)!.slice(1);
  return route.handler(request, { db: d1Db(env.DB), identity, env }, params);
}
