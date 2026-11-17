import type { Db, Param, Statement } from "../core/db.ts";
import type { SecretsApi } from "./context.ts";
import { CliError } from "./context.ts";

interface QueryResultLike {
  results?: unknown[];
  meta?: { changes?: number };
  success?: boolean;
}

/** The slice of the Cloudflare SDK the CLI uses, so tests can stand in for it. */
export interface D1Client {
  query(
    databaseId: string,
    body: { sql: string; params?: Param[] } | { batch: { sql: string; params?: Param[] }[] },
  ): Promise<QueryResultLike[]>;
}

/** A Db over Cloudflare's D1 HTTP API. */
export function cloudflareDb(client: D1Client, databaseId: string): Db {
  const single = async (sql: string, params: Param[] = []): Promise<QueryResultLike> => {
    const [result] = await client.query(databaseId, { sql, params });
    if (!result || result.success === false) throw new CliError("The D1 query failed");
    return result;
  };
  return {
    async all<T>(sql: string, params?: Param[]) {
      return ((await single(sql, params)).results ?? []) as T[];
    },
    async first<T>(sql: string, params?: Param[]) {
      return (((await single(sql, params)).results ?? [])[0] ?? null) as T | null;
    },
    async run(sql, params) {
      return { changes: (await single(sql, params)).meta?.changes ?? 0 };
    },
    async batch(statements: Statement[]) {
      const results = await client.query(databaseId, {
        batch: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })),
      });
      if (results.length !== statements.length || results.some((r) => r.success === false)) {
        throw new CliError("The D1 batch failed");
      }
      return results.map((r) => ({ changes: r.meta?.changes ?? 0 }));
    },
  };
}

export interface CloudflareConfig {
  apiToken: string;
  accountId: string;
  workerName: string;
  mailHostname: string;
}

export function loadConfig(env: Record<string, string | undefined>): CloudflareConfig {
  // The CLI can use a narrower token than the one used to deploy: AGENT_INBOX_CLI_API_TOKEN wins.
  const apiToken = env.AGENT_INBOX_CLI_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const workerName = env.AGENT_INBOX_WORKER_NAME;
  const mailHostname = env.AGENT_INBOX_MAIL_HOSTNAME;

  const missing = [
    ...(apiToken ? [] : ["AGENT_INBOX_CLI_API_TOKEN (or CLOUDFLARE_API_TOKEN)"]),
    ...(accountId ? [] : ["CLOUDFLARE_ACCOUNT_ID"]),
    ...(workerName ? [] : ["AGENT_INBOX_WORKER_NAME"]),
    ...(mailHostname ? [] : ["AGENT_INBOX_MAIL_HOSTNAME"]),
  ];
  if (missing.length) throw new CliError(`Missing environment variables: ${missing.join(", ")}`);
  return { apiToken: apiToken!, accountId: accountId!, workerName: workerName!, mailHostname: mailHostname! };
}

export function workersSecrets(
  client: { update(scriptName: string, body: { account_id: string; name: string; text: string; type: "secret_text" }): Promise<unknown> },
  config: CloudflareConfig,
): SecretsApi {
  return {
    async set(name, value) {
      await client.update(config.workerName, { account_id: config.accountId, name, text: value, type: "secret_text" });
    },
  };
}
