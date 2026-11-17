export type Param = string | number | null;

export interface Statement {
  sql: string;
  params?: Param[];
}

/**
 * The only database surface the Worker and the CLI share. The Worker backs it
 * with a D1 binding; the CLI backs it with the Cloudflare API.
 */
export interface Db {
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | null>;
  run(sql: string, params?: Param[]): Promise<{ changes: number }>;
  /** Runs the statements in order, atomically. */
  batch(statements: Statement[]): Promise<{ changes: number }[]>;
}

export function d1Db(d1: D1Database): Db {
  const prepare = (sql: string, params: Param[] = []) => d1.prepare(sql).bind(...params);
  return {
    async all<T>(sql: string, params?: Param[]) {
      const { results } = await prepare(sql, params).all<T>();
      return results;
    },
    async first<T>(sql: string, params?: Param[]) {
      return prepare(sql, params).first<T>();
    },
    async run(sql, params) {
      const result = await prepare(sql, params).run();
      return { changes: result.meta.changes };
    },
    async batch(statements) {
      const results = await d1.batch(statements.map((s) => prepare(s.sql, s.params)));
      return results.map((r) => ({ changes: r.meta.changes }));
    },
  };
}
