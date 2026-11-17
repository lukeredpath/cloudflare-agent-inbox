import { stripInvisible } from "../core/sanitise.ts";

/** One line of terminal-safe text: no control sequences, no invisible or bidi characters, no line breaks. */
export function printable(value: unknown): string {
  return stripInvisible(String(value ?? "")).replace(/\s+/g, " ").trim();
}

/** Removes control and invisible characters from every string in a value, for --json output. */
export function cleanDeep<T>(value: T): T {
  if (typeof value === "string") return stripInvisible(value) as T;
  if (Array.isArray(value)) return value.map(cleanDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanDeep(v)])) as T;
  }
  return value;
}

export function table(headers: string[], rows: unknown[][]): string[] {
  const cells = rows.map((r) => r.map(printable));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...cells.map(line)];
}

export const yesNo = (v: unknown) => (v ? "yes" : "no");
export const bytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);
