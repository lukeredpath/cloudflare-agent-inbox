import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// The admin app: built into dist/admin and served by the Worker as static assets.
// `npm run dev:admin` proxies /api to `wrangler dev`. The API refuses requests without an Access token,
// so a local development story still has to be added alongside the screens.
export default defineConfig({
  root: "src/admin",
  plugins: [preact()],
  build: { outDir: "../../dist/admin", emptyOutDir: true, sourcemap: false },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
