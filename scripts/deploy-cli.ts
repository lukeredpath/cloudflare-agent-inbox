import { spawnSync } from "node:child_process";
import { parseDatabaseList, planDeploy, type Step } from "./deploy.ts";

// Deploys from this checkout, with no GitHub or Workers Builds involved:
// render the config from AGENT_INBOX_* variables, then migrate and deploy in the right order.
const name = process.env.AGENT_INBOX_WORKER_NAME;
if (!name) {
  console.error("Missing environment variable: AGENT_INBOX_WORKER_NAME (see docs/deploy.md)");
  process.exit(1);
}

const run = (cmd: string, args: string[]) => {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.execPath, ["scripts/render-config-cli.ts"]);

const listed = spawnSync("npx", ["wrangler", "d1", "list", "--json"], { encoding: "utf8" });
const { steps, note } = planDeploy(listed.status === 0 ? parseDatabaseList(listed.stdout) : null, name);
console.log(`Deploy plan: ${steps.join(" then ")} (${note})`);

const commands: Record<Step, [string, string[]]> = {
  migrate: ["npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote", "-c", "dist/wrangler.jsonc"]],
  deploy: ["npx", ["wrangler", "deploy", "-c", "dist/wrangler.jsonc"]],
};
for (const step of steps) run(...commands[step]);
