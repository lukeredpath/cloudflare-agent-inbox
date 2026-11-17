import { describe, expect, it } from "vitest";
import { freshDb } from "./helpers/db";
import { workerFetch } from "./helpers/mail";

const call = workerFetch;

describe("host routing", () => {
  it("answers 404 on any other host, with no auth hint", async () => {
    await freshDb();
    const res = await call("https://elsewhere.example.com/mcp/agent");
    expect(res.status).toBe(404);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("does not serve MCP paths on the share host or share paths on the MCP host", async () => {
    await freshDb();
    expect((await call("https://files.example.com/mcp/agent", { method: "POST" })).status).toBe(404);
    expect((await call(`https://mcp.example.com/s/${"a".repeat(39)}`)).status).toBe(401);
  });
});
