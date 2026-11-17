import { loadEnvFiles } from "./env.ts";
import { runCli } from "./program.ts";
import { createNodeContext } from "./node.ts";

loadEnvFiles(".env.deploy", ".env");

process.exitCode = await runCli(process.argv.slice(2), createNodeContext(process.env));
