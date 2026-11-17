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
  const wanted = {
    apiToken: "CLOUDFLARE_API_TOKEN",
    accountId: "CLOUDFLARE_ACCOUNT_ID",
    workerName: "AGENT_INBOX_WORKER_NAME",
    mailHostname: "AGENT_INBOX_MAIL_HOSTNAME",
  } as const;
  const missing = Object.values(wanted).filter((name) => !env[name]);
  if (missing.length) throw new CliError(`Missing environment variables: ${missing.join(", ")}`);
  return {
    apiToken: env[wanted.apiToken]!,
    accountId: env[wanted.accountId]!,
    workerName: env[wanted.workerName]!,
    mailHostname: env[wanted.mailHostname]!,
  };
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
