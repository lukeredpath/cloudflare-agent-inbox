import { Command, CommanderError } from "commander";
import { ZodError } from "zod";
import { CoreError } from "../core/lanes.ts";
import * as c from "./commands.ts";
import { CliError, type CliContext } from "./context.ts";
import { cleanDeep } from "./format.ts";

const collect = (value: string, previous: string[] = []) => [...previous, value];
const int = (value: string) => {
  if (!/^\d+$/.test(value)) throw new CliError(`"${value.slice(0, 20)}" is not a whole number`);
  return Number(value);
};

function laneOptions(cmd: Command, forCreate: boolean): Command {
  cmd
    .option("--description <text>", "what the lane is for")
    .option("--allowed-sender <address>", "envelope sender allowed on this lane (repeatable; default: the deployment's list)", collect)
    .option(
      "--forwarded-from <rule>",
      "accept mail forwarded by a trusted forwarder from this original sender: address, *@domain or * (quote the *), optionally =dmarc,dkim,spf; wildcards need dmarc (repeatable; default dmarc)",
      collect,
    )
    .option("--shareable", "let agents create share links for this lane's files")
    .option("--allow-type <mime>", "attachment type the lane accepts (repeatable)", collect)
    .option("--max-attachment-bytes <n>", "largest accepted attachment", int)
    .option("--max-bytes <n>", "largest accepted message", int)
    .option("--max-text-chars <n>", "cap on the cleaned body length", int)
    .option("--retention-days <n>", "days before messages are purged", int)
    .option("--unzip-secret <NAME>", "unzip archives using this Worker secret (LANE_SECRET_...)")
    .option("--inner-type <mime>", "type allowed inside unzipped archives (repeatable)", collect);
  if (!forCreate) {
    cmd
      .option("--no-shareable", "turn share links off")
      .option("--clear-allowed-senders", "go back to the deployment's default senders")
      .option("--clear-forwarded-from", "stop accepting forwarded mail on this lane")
      .option("--no-unzip", "remove the unzip transform");
  }
  return cmd;
}

export function buildProgram(ctx: CliContext, emit: (result: c.Result, json: boolean) => void): Command {
  const program = new Command("agent-inbox")
    .description("Manage lanes, agents and secrets. Prints metadata only; message bodies need --show-body.")
    .option("--json", "machine-readable output")
    .showHelpAfterError(false)
    .exitOverride()
    .configureOutput({ writeOut: (s) => ctx.io.out(s.trimEnd()), writeErr: (s) => ctx.io.err(s.trimEnd()) });

  const json = (cmd: Command) => Boolean(cmd.optsWithGlobals().json);
  const run =
    <A extends unknown[]>(fn: (...args: A) => Promise<c.Result>) =>
    async (...args: unknown[]) => {
      const cmd = args[args.length - 1] as Command;
      emit(await fn(...(args.slice(0, -1) as A)), json(cmd));
    };
  const toFlags = (o: Record<string, unknown>): c.LaneFlags => {
    const { unzip, shareable, ...rest } = o as c.LaneFlags & { unzip?: boolean };
    return { ...rest, shareable, noUnzip: unzip === false ? true : undefined };
  };

  // lanes
  const lanes = program.command("lanes").description("create and manage lanes");
  laneOptions(lanes.command("create <slug>").description("create a lane and print its address"), true).action(
    run((slug: string, o: Record<string, unknown>) => c.lanesCreate(ctx, slug, toFlags(o))),
  );
  lanes.command("list").description("list lanes with status, address and counts").action(run(() => c.lanesList(ctx)));
  lanes.command("get <slug>").description("show one lane, with transform failures and active share links").action(run((slug: string) => c.lanesGet(ctx, slug)));
  laneOptions(lanes.command("update <slug>").description("change a lane without changing its address"), false).action(
    run((slug: string, o: Record<string, unknown>) => c.lanesUpdate(ctx, slug, toFlags(o))),
  );
  lanes.command("pause <slug>").description("reject mail for a lane").action(run((slug: string) => c.lanesSetStatus(ctx, slug, "paused")));
  lanes.command("resume <slug>").description("accept mail for a lane again").action(run((slug: string) => c.lanesSetStatus(ctx, slug, "active")));
  lanes.command("delete <slug>").option("--yes", "skip the confirmation").description("delete a lane and its messages")
    .action(run((slug: string, o: { yes?: boolean }) => c.lanesDelete(ctx, slug, o.yes)));
  lanes.command("rotate <slug>").option("--yes", "skip the confirmation").description("issue a new address; the old one stops working")
    .action(run((slug: string, o: { yes?: boolean }) => c.lanesRotate(ctx, slug, o.yes)));

  // agents
  const agents = program.command("agents").description("manage agent tokens and what they can read");
  agents.command("create <name>").description("create an agent and print its token once (interactive terminals only)")
    .action(async (name: string, _o: unknown, cmd: Command) => emit(await c.agentsCreate(ctx, name, json(cmd)), false));
  agents.command("list").description("list agents and their lanes").action(run(() => c.agentsList(ctx)));
  agents.command("grant <agent> <lane>").description("let an agent read a lane").action(run((a: string, l: string) => c.agentsGrant(ctx, a, l)));
  agents.command("ungrant <agent> <lane>").description("stop an agent reading a lane").action(run((a: string, l: string) => c.agentsUngrant(ctx, a, l)));
  agents.command("revoke <agent>").option("--yes", "skip the confirmation").description("disable an agent's token")
    .action(run((a: string, o: { yes?: boolean }) => c.agentsRevoke(ctx, a, o.yes)));

  // secrets
  program.command("secrets").description("manage Worker secrets").command("set <name>")
    .description("set a lane secret; the value is read from the terminal or stdin, never from an argument")
    .action(run((name: string) => c.secretsSet(ctx, name)));

  // messages
  const messages = program.command("messages").description("inspect and fix messages");
  messages.command("list").description("list messages (metadata only)")
    .option("--lane <slug>").option("--unprocessed", "only unprocessed messages").option("--limit <n>", "at most this many (max 100)", int)
    .action(run((o: { lane?: string; unprocessed?: boolean; limit?: number }) => c.messagesList(ctx, o)));
  messages.command("get <id>").description("show one message's metadata and files")
    .option("--show-body", "also print the cleaned body (untrusted content; for you to read yourself)")
    .action(run((id: string, o: { showBody?: boolean }) => c.messagesGet(ctx, id, o.showBody)));
  messages.command("mark-unprocessed <id>").description("hand a message back to the agent").action(run((id: string) => c.messagesMarkUnprocessed(ctx, id)));
  messages.command("keep <id>").description("exempt a message from retention").option("--off", "remove the exemption")
    .action(run((id: string, o: { off?: boolean }) => c.messagesKeep(ctx, id, o.off)));
  messages.command("delete <id>").option("--yes", "skip the confirmation").description("remove a message")
    .action(run((id: string, o: { yes?: boolean }) => c.messagesDelete(ctx, id, o.yes)));
  messages.command("inject-test <lane>").description("put a synthetic message, marked as a test, into a lane")
    .option("--subject <text>").option("--text <text>", "message body").option("--stdin", "read the body from stdin")
    .action(run((lane: string, o: { subject?: string; text?: string; stdin?: boolean }) => c.messagesInjectTest(ctx, lane, o)));

  // rejections
  program.command("rejections").description("see what was rejected and why").command("list")
    .option("--lane <slug>").option("--limit <n>", "at most this many (max 200)", int)
    .option("--diagnostics", "also print the authentication-header excerpt kept for failed forwards")
    .action(run((o: { lane?: string; limit?: number; diagnostics?: boolean }) => c.rejectionsList(ctx, o)));

  return program;
}

/** Runs one invocation and returns the process exit code. */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const emit = (result: c.Result, asJson: boolean) => {
    if (asJson) ctx.io.out(JSON.stringify(cleanDeep(result.data), null, 2));
    else for (const line of result.lines) ctx.io.out(line);
  };
  try {
    await buildProgram(ctx, emit).parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    if (e instanceof CliError || e instanceof CoreError) ctx.io.err(`Error: ${e.message}`);
    else if (e instanceof ZodError) ctx.io.err(`Error: invalid value: ${e.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`);
    else ctx.io.err("Error: something went wrong (details are not shown in case they contain private data)");
    return 1;
  }
}
