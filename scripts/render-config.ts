const PLACEHOLDER = /<([A-Z][A-Z0-9_]*)>/g;
const ENV_PREFIX = "AGENT_INBOX_";
// Hostnames, worker names and comma-separated address lists only. Anything
// else could break out of a JSON string.
const RELATIVE_PATH_KEYS = ["main", "migrations_dir"];
const SAFE_VALUE = /^[A-Za-z0-9._,@+:/-]+$/;

export interface RenderOptions {
  /** Prefix that turns the template's relative paths into ones valid from the rendered file's directory. */
  relocateMainBy?: string;
}

/**
 * Replaces every <NAME> token with env[AGENT_INBOX_NAME]. Throws on a missing,
 * unsafe or self-referencing value. Error messages name variables, never values.
 */
export function renderConfig(
  template: string,
  env: Record<string, string | undefined>,
  options: RenderOptions = {},
): string {
  const names = [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!))];

  const missing = names.filter((n) => !env[ENV_PREFIX + n]);
  if (missing.length > 0) {
    throw new Error(`Missing build variables: ${missing.map((n) => ENV_PREFIX + n).join(", ")}`);
  }

  const unsafe = names.filter((n) => !SAFE_VALUE.test(env[ENV_PREFIX + n]!));
  if (unsafe.length > 0) {
    throw new Error(`Unsupported characters in: ${unsafe.map((n) => ENV_PREFIX + n).join(", ")}`);
  }

  let rendered = template.replace(PLACEHOLDER, (_, name: string) => env[ENV_PREFIX + name]!);

  if (PLACEHOLDER.test(rendered)) {
    PLACEHOLDER.lastIndex = 0;
    throw new Error("A build variable value contains a placeholder-like token");
  }
  PLACEHOLDER.lastIndex = 0;

  if (options.relocateMainBy) {
    // Paths in a Wrangler config resolve relative to the config file itself.
    for (const key of RELATIVE_PATH_KEYS) {
      rendered = rendered.replace(
        new RegExp(`("${key}"\\s*:\\s*")([^"]+)(")`, "g"),
        (_, open: string, path: string, close: string) => `${open}${options.relocateMainBy}${path}${close}`,
      );
    }
  }
  return rendered;
}
