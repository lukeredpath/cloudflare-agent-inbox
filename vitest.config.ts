import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
  // Local tooling keeps worktrees (full copies of the repo) under .claude/.
  test: { exclude: [...configDefaults.exclude, ".claude/**"] },
});
