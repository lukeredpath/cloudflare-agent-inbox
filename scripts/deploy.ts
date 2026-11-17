export type Step = "migrate" | "deploy";

export interface Database {
  name: string;
  uuid?: string;
}

/** Parses `wrangler d1 list --json`. Returns null when the output is not a list of databases. */
export function parseDatabaseList(stdout: string): Database[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((d): d is Database => typeof d?.name === "string");
  } catch {
    return null;
  }
}

/**
 * The order to run things in. With an existing database, migrate first so new
 * code never runs on an old schema. On a fresh account the database does not
 * exist until the first deploy provisions it, so deploy first, then migrate.
 * If the lookup failed (for example a token without D1 read), assume it exists.
 */
export function planDeploy(databases: Database[] | null, name: string): { steps: Step[]; note: string } {
  if (databases === null) {
    return { steps: ["migrate", "deploy"], note: "could not list databases; assuming it already exists" };
  }
  return databases.some((d) => d.name === name)
    ? { steps: ["migrate", "deploy"], note: "database exists" }
    : { steps: ["deploy", "migrate"], note: "no database yet: deploying first so it is provisioned, then migrating" };
}
