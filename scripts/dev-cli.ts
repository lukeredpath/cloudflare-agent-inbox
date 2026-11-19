import { spawn, spawnSync } from "node:child_process";

// Local development: a local D1 and R2 with synthetic data, the real Worker standing in for
// Cloudflare Access (src/dev/worker.ts), and the admin app with hot reload.
//   npm run dev              start everything (seeds an empty local database)
//   npm run dev -- --reseed  throw the local data away and seed it again
const config = "wrangler.dev.jsonc";
// 8787 (Wrangler's default) is often taken by another project; override with DEV_WORKER_PORT.
const workerPort = process.env.DEV_WORKER_PORT ?? "8799";
const reseed = process.argv.includes("--reseed");

const run = (args: string[], capture = false) => {
  const result = spawnSync("npx", args, capture ? { encoding: "utf8" } : { stdio: "inherit" });
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return String(result.stdout ?? "");
};

// Wrangler needs the built app to exist even though the dev server does not use it.
run(["vite", "build", "--logLevel", "warn"]);
run(["wrangler", "d1", "migrations", "apply", "DB", "--local", "-c", config]);

const count = run(["wrangler", "d1", "execute", "DB", "--local", "-c", config, "--json", "--command", "SELECT COUNT(*) AS n FROM lanes"], true);
const empty = (JSON.parse(count) as { results: { n: number }[] }[])[0]?.results[0]?.n === 0;
if (reseed || empty) {
  console.log(reseed ? "Reseeding the local database." : "Seeding the empty local database.");
  run(["wrangler", "d1", "execute", "DB", "--local", "-c", config, "--file", "dev/seed.sql"]);
}

const children = [
  spawn("npx", ["wrangler", "dev", "-c", config, "--port", workerPort], { stdio: "inherit" }),
  spawn("npx", ["vite", "--port", "5173", "--strictPort"], { stdio: "inherit", env: { ...process.env, DEV_WORKER_PORT: workerPort } }),
];
const stop = () => children.forEach((c) => c.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
children.forEach((c) => c.on("exit", () => (stop(), process.exit(0))));
console.log(`\nAdmin app (hot reload):   http://localhost:5173\nAs built, via the Worker: http://localhost:${workerPort}\n`);
