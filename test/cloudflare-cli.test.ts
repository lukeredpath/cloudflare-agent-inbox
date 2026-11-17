import { describe, expect, it, vi } from "vitest";
import { cloudflareDb, loadConfig, workersSecrets, type D1Client } from "../src/cli/cloudflare";

function client(results: unknown[][]) {
  const query = vi.fn<D1Client["query"]>(async () => results.shift() as never);
  return { client: { query } as D1Client, query };
}

describe("cloudflareDb", () => {
  it("maps rows, first, and change counts, passing parameters through untouched", async () => {
    const { client: c, query } = client([[{ results: [{ n: 1 }, { n: 2 }], success: true }], [{ results: [], success: true }], [{ meta: { changes: 3 }, success: true }]]);
    const db = cloudflareDb(c, "db-1");
    expect(await db.all("SELECT n", [1, "a", null])).toEqual([{ n: 1 }, { n: 2 }]);
    expect(query).toHaveBeenCalledWith("db-1", { sql: "SELECT n", params: [1, "a", null] });
    expect(await db.first("SELECT x")).toBeNull();
    expect(await db.run("UPDATE x")).toEqual({ changes: 3 });
  });

  it("batches statements and reports each count", async () => {
    const { client: c, query } = client([[{ meta: { changes: 1 }, success: true }, { meta: { changes: 2 }, success: true }]]);
    const result = await cloudflareDb(c, "db-1").batch([{ sql: "A", params: [1] }, { sql: "B" }]);
    expect(result).toEqual([{ changes: 1 }, { changes: 2 }]);
    expect(query).toHaveBeenCalledWith("db-1", { batch: [{ sql: "A", params: [1] }, { sql: "B", params: [] }] });
  });

  it("fails on an unsuccessful result without leaking the query", async () => {
    const { client: c } = client([[{ success: false }], [{ meta: {}, success: true }]]);
    const db = cloudflareDb(c, "db-1");
    await expect(db.all("SELECT secret FROM t WHERE x = 'private'")).rejects.toThrow("The D1 query failed");
    await expect(db.batch([{ sql: "A" }, { sql: "B" }])).rejects.toThrow("The D1 batch failed");
  });
});

describe("loadConfig", () => {
  const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", AGENT_INBOX_WORKER_NAME: "w", AGENT_INBOX_MAIL_HOSTNAME: "m.example.com" };
  it("reads the four variables", () => {
    expect(loadConfig(env)).toEqual({ apiToken: "t", accountId: "a", workerName: "w", mailHostname: "m.example.com" });
  });
  it("prefers a dedicated CLI token over the deploy token", () => {
    expect(loadConfig({ ...env, AGENT_INBOX_CLI_API_TOKEN: "narrow" }).apiToken).toBe("narrow");
    expect(loadConfig({ ...env, AGENT_INBOX_CLI_API_TOKEN: "" }).apiToken).toBe("t");
    const { CLOUDFLARE_API_TOKEN: _drop, ...onlyCli } = env;
    expect(loadConfig({ ...onlyCli, AGENT_INBOX_CLI_API_TOKEN: "narrow" }).apiToken).toBe("narrow");
  });
  it("names missing variables and never echoes values", () => {
    try {
      loadConfig({ CLOUDFLARE_API_TOKEN: "super-secret-token" });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("CLOUDFLARE_ACCOUNT_ID");
      expect(msg).toContain("AGENT_INBOX_WORKER_NAME");
      expect(msg).not.toContain("super-secret-token");
      expect(msg).not.toMatch(/AGENT_INBOX_CLI_API_TOKEN/);
    }
    expect(() => loadConfig({})).toThrow(/AGENT_INBOX_CLI_API_TOKEN \(or CLOUDFLARE_API_TOKEN\)/);
  });
});

describe("workersSecrets", () => {
  it("sets a secret_text binding on the configured worker", async () => {
    const update = vi.fn(async () => ({}));
    await workersSecrets({ update }, { apiToken: "t", accountId: "acct", workerName: "worker", mailHostname: "m" }).set("LANE_SECRET_X", "v");
    expect(update).toHaveBeenCalledWith("worker", { account_id: "acct", name: "LANE_SECRET_X", text: "v", type: "secret_text" });
  });
});
