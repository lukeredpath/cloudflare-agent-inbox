export type LogFields = Record<string, string | number | boolean | null | string[]>;

/**
 * One structured JSON line per event, for Workers Logs. Metadata only: never
 * addresses, subjects, bodies, tokens or deployment values. Lane and agent
 * identifiers are fine; they are meaningless outside the database.
 */
export function logEvent(event: string, fields: LogFields = {}, level: "log" | "warn" | "error" = "log"): void {
  console[level](JSON.stringify({ event, ...fields }));
}
