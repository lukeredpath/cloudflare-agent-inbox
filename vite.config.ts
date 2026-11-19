import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// The admin app: built into dist/admin and served by the Worker as static assets.
// `npm run dev` proxies /api to the local Worker (see scripts/dev-cli.ts), which stands in for Access.
// The Host header stays the browser's own, because the Worker's same-origin check compares it with Origin.
export default defineConfig({
  root: "src/admin",
  plugins: [preact()],
  build: { outDir: "../../dist/admin", emptyOutDir: true, sourcemap: false },
  server: {
    proxy: {
      "/api": { target: `http://localhost:${process.env.DEV_WORKER_PORT ?? "8799"}`, headers: { host: "localhost:5173" } },
    },
  },
});
