import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDenylist, scan, type ScanFile } from "./pii-scan.ts";

// The denylist holds the personal values to keep out of the repo, so it lives
// outside version control: a git-ignored .pii-denylist, or a file in ~/.config.
const candidates = [
  process.env.AGENT_INBOX_DENYLIST,
  ".pii-denylist",
  join(homedir(), ".config", "agent-inbox", "denylist.txt"),
].filter((p): p is string => Boolean(p));

const denylistPath = candidates.find((p) => existsSync(p));
if (!denylistPath) {
  console.warn("pii-scan: no denylist found (.pii-denylist or ~/.config/agent-inbox/denylist.txt); skipping");
  process.exit(process.argv.includes("--require") ? 1 : 0);
  throw new Error("unreachable");
}

const denylist = parseDenylist(readFileSync(denylistPath, "utf8"));
const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const files: ScanFile[] = [];
for (const path of paths) {
  if (!existsSync(path)) continue;
  const buf = readFileSync(path);
  if (buf.includes(0)) continue; // binary
  files.push({ path, content: buf.toString("utf8") });
}

const hits = scan(files, denylist);
for (const h of hits) console.error(`pii-scan: ${h.path}${h.line ? `:${h.line}` : " (path)"} matches denylist entry ${h.entry}`);
if (hits.length > 0) process.exit(1);
console.log(`pii-scan: ${files.length} files clean against ${denylist.length} entries`);
