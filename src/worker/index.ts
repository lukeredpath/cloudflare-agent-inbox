import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { d1Db } from "../core/db.ts";
import { authenticateAgent } from "./auth.ts";
import { handleEmail } from "./email.ts";
import { logEvent } from "./log.ts";
import type { Env } from "./env.ts";
import { buildServer } from "./mcp.ts";
import { purge } from "./purge.ts";
import { handleShare } from "./share.ts";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function handleMcp(request: Request, env: Env): Promise<Response> {
  const db = d1Db(env.DB);
  // Authenticate everything on this host, including unknown paths, before saying anything else.
  const agent = await authenticateAgent(db, request.headers.get("authorization"));
  if (!agent) return json(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="agent-inbox"' });

  if (new URL(request.url).pathname !== "/mcp/agent") return json(404, { error: "not found" });
  // Stateless server: no SSE stream to resume and no session to delete.
  if (request.method !== "POST") {
    return json(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, { allow: "POST" });
  }

  const server = buildServer({
    db,
    agent,
    shareHostname: env.SHARE_HOSTNAME,
    log: (f) => logEvent("mcp", { agent: agent.id, ...f }, f.outcome === "internal_error" ? "error" : "log"),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export default {
  async email(message, env, _ctx): Promise<void> {
    await handleEmail(message, env);
  },

  // The two hostnames serve different things: share links on one, the agent MCP on the other.
  async fetch(request, env, _ctx): Promise<Response> {
    const host = new URL(request.url).hostname.toLowerCase();
    if (host === env.SHARE_HOSTNAME.toLowerCase()) return handleShare(request, env);
    if (host === env.MCP_HOSTNAME.toLowerCase()) return handleMcp(request, env);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(purge(env));
  },
} satisfies ExportedHandler<Env>;
