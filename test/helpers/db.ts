import { env } from "cloudflare:test";
import { d1Db, type Db } from "../../src/core/db";

const migrations = import.meta.glob("../../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

const TABLES = ["lanes", "agents", "agent_lanes", "messages", "attachments", "shares", "rejections", "ingest_keys", "settings"];
const applied = new WeakSet<object>();

/** One statement per `;`. D1's exec() wants one statement per line, so run them individually. */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A Db over the test D1 binding, with the real migrations applied and every table empty. */
export async function freshDb(): Promise<Db> {
  const d1 = (env as unknown as { DB: D1Database }).DB;
  if (!applied.has(d1)) {
    for (const path of Object.keys(migrations).sort()) {
      for (const stmt of statements(migrations[path]!)) await d1.prepare(stmt).run();
    }
    applied.add(d1);
  }
  await d1.batch(TABLES.map((t) => d1.prepare(`DELETE FROM ${t}`)));
  return d1Db(d1);
}
