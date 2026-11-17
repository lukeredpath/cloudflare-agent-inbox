import { runCli } from "./program.ts";
import { createNodeContext } from "./node.ts";

process.exitCode = await runCli(process.argv.slice(2), createNodeContext(process.env));
