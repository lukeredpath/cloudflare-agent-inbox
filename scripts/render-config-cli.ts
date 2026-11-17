import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvFiles } from "../src/cli/env.ts";
import { renderConfig } from "./render-config.ts";

// Writes dist/wrangler.jsonc and the redirect Wrangler follows
// (.wrangler/deploy/config.json), so a plain `wrangler deploy` uses it.
loadEnvFiles(".env.deploy", ".env");
const template = readFileSync("wrangler.example.jsonc", "utf8");
const rendered = renderConfig(template, process.env, { relocateMainBy: "../" });

mkdirSync("dist", { recursive: true });
writeFileSync("dist/wrangler.jsonc", rendered);
mkdirSync(".wrangler/deploy", { recursive: true });
writeFileSync(".wrangler/deploy/config.json", JSON.stringify({ configPath: "../../dist/wrangler.jsonc" }) + "\n");
console.log("Rendered dist/wrangler.jsonc");
