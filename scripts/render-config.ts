// `<NAME>` is required. `<NAME?>` is optional: a line that mentions one whose variable is unset is dropped.
const PLACEHOLDER = /<([A-Z][A-Z0-9_]*)(\?)?>/g;
const ENV_PREFIX = "AGENT_INBOX_";
// Hostnames, worker names and comma-separated address lists only. Anything
// else could break out of a JSON string.
const RELATIVE_PATH_KEYS = ["main", "migrations_dir", "directory"];
/** Optional variables that only make sense together: all set, or none. */
const OPTIONAL_GROUPS = [["ADMIN_HOSTNAME", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"]];
const HOSTNAME_KEYS = ["MAIL_HOSTNAME", "MCP_HOSTNAME", "SHARE_HOSTNAME", "ADMIN_HOSTNAME"];
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
  const isSet = (name: string) => Boolean(env[ENV_PREFIX + name]);

  for (const group of OPTIONAL_GROUPS) {
    const set = group.filter(isSet);
    if (set.length > 0 && set.length < group.length) {
      throw new Error(`Set all of these build variables or none: ${group.map((n) => ENV_PREFIX + n).join(", ")}`);
    }
  }

  const hostnames = HOSTNAME_KEYS.filter(isSet).map((n) => env[ENV_PREFIX + n]!.toLowerCase());
  if (new Set(hostnames).size !== hostnames.length) {
    throw new Error(`Each of ${HOSTNAME_KEYS.map((n) => ENV_PREFIX + n).join(", ")} must be a different hostname`);
  }

  // Drop lines that depend on an optional variable that is not set.
  const kept = template.split("\n").filter((line) => {
    const optional = [...line.matchAll(PLACEHOLDER)].filter((m) => m[2]).map((m) => m[1]!);
    return optional.every(isSet);
  });
  const body = kept.join("\n");

  const names = [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]!))];

  const missing = names.filter((n) => !isSet(n));
  if (missing.length > 0) {
    throw new Error(`Missing build variables: ${missing.map((n) => ENV_PREFIX + n).join(", ")}`);
  }

  const unsafe = names.filter((n) => !SAFE_VALUE.test(env[ENV_PREFIX + n]!));
  if (unsafe.length > 0) {
    throw new Error(`Unsupported characters in: ${unsafe.map((n) => ENV_PREFIX + n).join(", ")}`);
  }

  let rendered = body.replace(PLACEHOLDER, (_, name: string) => env[ENV_PREFIX + name]!);

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
