import { createInterface } from "node:readline";
import Cloudflare from "cloudflare";
import { cloudflareDb, loadConfig, workersSecrets } from "./cloudflare.ts";
import { CliError, type CliContext, type CliIo } from "./context.ts";

function nodeIo(): CliIo {
  return {
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    async confirm(question) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await new Promise<string>((resolve) => rl.question(`${question} Type "yes" to continue: `, resolve));
        return answer.trim().toLowerCase() === "yes";
      } finally {
        rl.close();
      }
    },
    async readStdin() {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    readSecret(prompt) {
      return new Promise((resolve, reject) => {
        process.stderr.write(prompt);
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        let value = "";
        const finish = (fn: () => void) => {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          fn();
        };
        const onData = (chunk: string) => {
          for (const ch of chunk) {
            if (ch === "\r" || ch === "\n") return finish(() => resolve(value));
            if (ch === "\u0003") return finish(() => reject(new CliError("Cancelled")));
            if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
            else value += ch;
          }
        };
        stdin.on("data", onData);
      });
    },
  };
}

/**
 * Builds the real context: Cloudflare's D1 API, Workers secrets API and the
 * terminal. Credentials are only needed once a command touches them, so
 * `--help` works without any configuration.
 */
export function createNodeContext(env: Record<string, string | undefined>): CliContext {
  let connected: Promise<{ db: CliContext["db"]; secrets: CliContext["secrets"] }> | undefined;
  const connect = () =>
    (connected ??= (async () => {
      const config = loadConfig(env);
      const sdk = new Cloudflare({ apiToken: config.apiToken });

      const found = [];
      for await (const db of sdk.d1.database.list({ account_id: config.accountId, name: config.workerName })) {
        if (db.name === config.workerName) found.push(db);
      }
      const database = found[0];
      if (!database?.uuid) throw new CliError("No D1 database matches the configured worker name");

      const d1 = {
        async query(databaseId: string, body: Record<string, unknown>) {
          // The API accepts JSON numbers and nulls as bind parameters; the SDK's types say strings.
          const page = await sdk.d1.database.query(databaseId, { account_id: config.accountId, ...body } as never);
          return page.result;
        },
      };
      return { db: cloudflareDb(d1, database.uuid), secrets: workersSecrets(sdk.workers.scripts.secrets, config) };
    })());

  return {
    db: {
      all: async (sql, params) => (await connect()).db.all(sql, params),
      first: async (sql, params) => (await connect()).db.first(sql, params),
      run: async (sql, params) => (await connect()).db.run(sql, params),
      batch: async (statements) => (await connect()).db.batch(statements),
    },
    secrets: { set: async (name, value) => (await connect()).secrets.set(name, value) },
    mailHostname: env.AGENT_INBOX_MAIL_HOSTNAME ?? "",
    io: nodeIo(),
  };
}
