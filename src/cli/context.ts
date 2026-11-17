import type { Db } from "../core/db.ts";

export class CliError extends Error {}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  /** Asks a yes/no question on the terminal. Only called when stdin is a TTY. */
  confirm(question: string): Promise<boolean>;
  /** Reads all of piped stdin. */
  readStdin(): Promise<string>;
  /** Reads one line from the terminal without echoing it. */
  readSecret(prompt: string): Promise<string>;
}

export interface SecretsApi {
  set(name: string, value: string): Promise<void>;
}

export interface CliContext {
  db: Db;
  secrets: SecretsApi;
  mailHostname: string;
  io: CliIo;
}
