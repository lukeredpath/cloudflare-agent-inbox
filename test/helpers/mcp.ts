import { createExecutionContext } from "cloudflare:test";
import type { Db } from "../../src/core/db";
import { createAgent, grantLane } from "../../src/core/agents";
import type { Lane } from "../../src/core/lanes";
import worker from "../../src/worker/index";
import { testEnv } from "./mail";

export const MCP_URL = "https://mcp.example.com/mcp/agent";

export interface RpcResult {
  status: number;
  body: any;
}

export async function rpc(token: string | null, method: string, params: unknown = {}): Promise<RpcResult> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await worker.fetch(
    new Request(MCP_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }),
    testEnv(),
    createExecutionContext(),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export interface ToolResult {
  isError: boolean;
  data: any;
  text: string;
}

export async function callTool(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const { body } = await rpc(token, "tools/call", { name, arguments: args });
  const text: string = body.result?.content?.[0]?.text ?? body.error?.message ?? "";
  const isError = Boolean(body.result?.isError) || Boolean(body.error);
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    // an error message, not JSON
  }
  return { isError, data, text };
}

export async function agentWith(db: Db, name: string, lanes: Lane[]): Promise<{ id: string; token: string }> {
  const { agent, token } = await createAgent(db, name);
  for (const lane of lanes) await grantLane(db, agent.id, lane.id);
  return { id: agent.id, token };
}
