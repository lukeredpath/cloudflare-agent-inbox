import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { chromium, type Page } from "playwright-core";

// Regenerates the admin screenshots used by the website and the README, in light and dark,
// from the synthetic seed data (dev/seed.sql). It starts the local dev stack itself, so
// nothing else may be using ports 5173 and 8799.
//
//   npx playwright-core install chromium   # once, for the browser
//   brew install webp                       # once, for cwebp (libwebp-tools on Debian and Ubuntu)
//   npm run screenshots
//
// The pictures are stored as lossless WebP: identical pixels at about a third of the size of PNG.
// Set CHROMIUM_PATH to use a Chromium you already have instead of Playwright's own.
const OUT = "site/screenshots";
const BASE = "http://localhost:8799";
const WIDTH = 1280;

interface Shot {
  name: string;
  hash: string;
  height: number;
  /** Anything to do on the page before it is photographed. */
  prepare?: (page: Page) => Promise<void>;
  /** Something that is only on screen once the page is ready. */
  ready: string;
}

const SHOTS: Shot[] = [
  { name: "overview", hash: "#overview", height: 820, ready: "text=Needs attention" },
  {
    name: "message",
    hash: "#messages/01DEV0000000000000000MSG04",
    height: 900,
    ready: "text=Body not loaded",
    // The body is only fetched on request, so the picture shows it being asked for.
    prepare: async (page) => {
      await page.getByRole("button", { name: "Show body" }).click();
      await page.locator(".ut-body", { hasText: "maintenance mode" }).waitFor();
    },
  },
];

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

if (spawnSync("cwebp", ["-version"]).error) {
  console.error("cwebp is not installed. Install libwebp (for example `brew install webp`) and try again.");
  process.exit(1);
}

for (const port of [5173, 8799]) {
  if (await portOpen(port)) {
    console.error(`Port ${port} is already in use. Stop your dev server first: this script starts its own.`);
    process.exit(1);
  }
}

// A detached group, so the whole stack (Wrangler and Vite included) can be stopped together.
const stack = spawn(process.execPath, ["scripts/dev-cli.ts", "--reseed"], { detached: true, stdio: "ignore" });
const stop = () => {
  try {
    process.kill(-stack.pid!, "SIGTERM");
  } catch {
    // already gone
  }
};
process.on("exit", stop);
process.on("SIGINT", () => (stop(), process.exit(130)));

try {
  console.log("Starting the local stack and seeding it…");
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/lanes`);
      // Seeded, not merely up: the overview must have its lanes.
      if (res.ok && ((await res.json()) as unknown[]).length > 0) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("The local stack did not become ready in time.");
    await new Promise((r) => setTimeout(r, 1000));
  }

  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    for (const scheme of ["light", "dark"] as const) {
      // Twice the pixels, so the pictures stay sharp on high-density screens.
      const context = await browser.newContext({ viewport: { width: WIDTH, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme });
      for (const shot of SHOTS) {
        const page = await context.newPage();
        await page.setViewportSize({ width: WIDTH, height: shot.height });
        await page.goto(`${BASE}/${shot.hash}`);
        await page.locator(shot.ready).first().waitFor();
        await page.waitForLoadState("networkidle");
        await shot.prepare?.(page);
        const path = `${OUT}/${shot.name}-${scheme}.webp`;
        const encoded = spawnSync("cwebp", ["-quiet", "-lossless", "-z", "9", "-o", path, "--", "-"], { input: await page.screenshot() });
        if (encoded.status !== 0) throw new Error(`cwebp failed: ${encoded.stderr}`);
        console.log(`wrote ${path}`);
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  stop();
}
