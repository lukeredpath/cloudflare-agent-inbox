import { vi } from "vitest";
import type { Db } from "../../src/core/db";
import type { CliContext } from "../../src/cli/context";
import { runCli } from "../../src/cli/program";

export interface CliRun {
  code: number;
  out: string;
  err: string;
  /** Everything the CLI printed, for leak checks. */
  all: string;
  asked: string[];
}

export interface CliOptions {
  /** A terminal on both stdin and stdout. Default false (as when a tool runs the CLI). */
  tty?: boolean;
  stdin?: string;
  confirm?: boolean;
  secret?: string;
}

export function makeCli(db: Db) {
  const setSecret = vi.fn(async (_name: string, _value: string) => {});
  const ctx = (io: CliContext["io"]): CliContext => ({ db, secrets: { set: setSecret }, mailHostname: "mail.example.com", io });

  async function cli(args: string[], o: CliOptions = {}): Promise<CliRun> {
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    const io: CliContext["io"] = {
      out: (l) => void out.push(l),
      err: (l) => void err.push(l),
      stdoutIsTTY: o.tty ?? false,
      stdinIsTTY: o.tty ?? false,
      confirm: async (q) => (asked.push(q), o.confirm ?? false),
      readStdin: async () => o.stdin ?? "",
      readSecret: async (p) => (asked.push(p), o.secret ?? ""),
    };
    const code = await runCli(args, ctx(io));
    return { code, out: out.join("\n"), err: err.join("\n"), all: [...out, ...err].join("\n"), asked };
  }
  return { cli, setSecret };
}
