import { beforeEach, describe, expect, it } from "vitest";
import { createAgent, getAgentByName } from "../src/core/agents";
import type { Db } from "../src/core/db";
import { sha256Hex } from "../src/core/encoding";
import { createLane, getLaneBySlug, type Lane } from "../src/core/lanes";
import { insertMessage, listMessagesForAgent } from "../src/core/messages";
import { logRejection } from "../src/core/rejections";
import { createShare } from "../src/core/shares";
import { AGENT_TOKEN_PATTERN } from "../src/core/tokens";
import { freshDb } from "./helpers/db";
import { makeCli } from "./helpers/cli";

let db: Db;
let cli: ReturnType<typeof makeCli>["cli"];
let setSecret: ReturnType<typeof makeCli>["setSecret"];

beforeEach(async () => {
  db = await freshDb();
  ({ cli, setSecret } = makeCli(db));
});

const SENTINEL = "SENTINEL-BODY-TEXT-do-not-print";
async function seedMessage(lane: Lane, id = "01HZ0000000000000000000001", extra: { subject?: string } = {}) {
  await insertMessage(
    db,
    {
      id, laneId: lane.id, receivedAt: "2026-01-01T00:00:00.000Z", envelopeFrom: "sender@example.com", headerFrom: "h@example.net",
      originalFrom: "o@example.net", subject: extra.subject ?? "Hello", size: 2048, authSummary: "dkim=pass header.d=example.com",
      cleanText: SENTINEL, rawKey: `raw/${id}`, isTest: false,
    },
    [{ id: `att-${id}`, parentId: null, filename: "f.pdf", contentType: "application/pdf", size: 10, r2Key: "k", transformError: "archive could not be read" }],
  );
}

describe("lanes", () => {
  it("creates a lane and prints its address", async () => {
    const r = await cli(["lanes", "create", "receipts", "--description", "Shop receipts"]);
    expect(r.code).toBe(0);
    const lane = (await getLaneBySlug(db, "receipts"))!;
    expect(r.out).toContain(`Address:        inbox+${lane.addressToken}@mail.example.com`);
    expect(lane).toMatchObject({ status: "active", shareable: false, description: "Shop receipts", retentionDays: 90 });
    expect(lane.attachmentPolicy.allowed_types).toEqual([]);
  });

  it("creates a lane with an unzip transform, types and limits", async () => {
    const r = await cli([
      "lanes", "create", "invoices", "--shareable", "--allow-type", "application/pdf", "--unzip-secret", "LANE_SECRET_INV",
      "--inner-type", "application/pdf", "--allowed-sender", "Me@Example.com", "--retention-days", "400", "--max-bytes", "5000000",
    ]);
    expect(r.code).toBe(0);
    const lane = (await getLaneBySlug(db, "invoices"))!;
    expect(lane).toMatchObject({ shareable: true, retentionDays: 400, maxBytes: 5_000_000, allowedSenders: ["me@example.com"] });
    expect(lane.attachmentPolicy.transforms).toEqual([{ type: "unzip", password_secret: "LANE_SECRET_INV", allow_inner_types: ["application/pdf"] }]);
    expect(r.out).toContain("unzip with secret LANE_SECRET_INV");
  });

  it("outputs JSON with --json", async () => {
    const r = await cli(["--json", "lanes", "create", "a"]);
    expect(JSON.parse(r.out)).toMatchObject({ slug: "a", status: "active", address: expect.stringMatching(/^inbox\+[a-z2-7]{32}@mail\.example\.com$/) });
  });

  it("refuses bad input with a clear error and a non-zero exit", async () => {
    expect((await cli(["lanes", "create", "Bad Slug"])).code).toBe(1);
    const noInner = await cli(["lanes", "create", "x", "--unzip-secret", "LANE_SECRET_X"]);
    expect(noInner).toMatchObject({ code: 1 });
    expect(noInner.err).toContain("--inner-type");
    const wrongSecret = await cli(["lanes", "create", "x", "--unzip-secret", "CLOUDFLARE_API_TOKEN", "--inner-type", "application/pdf"]);
    expect(wrongSecret.code).toBe(1);
    expect(await getLaneBySlug(db, "x")).toBeNull();
    expect((await cli(["lanes", "create", "ok", "--retention-days", "lots"])).code).toBe(1);
    expect((await cli(["lanes", "create", "ok"])).code).toBe(0);
    expect((await cli(["lanes", "create", "ok"])).err).toContain("already exists");
  });

  it("lists lanes with address and counts, and gets one with transform failures and share metadata", async () => {
    const lane = await createLane(db, { slug: "invoices", shareable: true });
    await seedMessage(lane);
    const { agent } = await createAgent(db, "bot");
    await createShare(db, `att-01HZ0000000000000000000001`, agent.id, 10);

    const list = await cli(["lanes", "list"]);
    expect(list.out).toMatch(/invoices\s+active\s+1\s+1\s+2026-01-01/);
    expect(list.out).toContain(`inbox+${lane.addressToken}@mail.example.com`);

    const get = await cli(["lanes", "get", "invoices"]);
    expect(get.out).toContain("Transform failures: 1");
    expect(get.out).toContain("archive could not be read");
    expect(get.out).toContain("Active share links: 1");
    expect(get.out).toContain("f.pdf by bot");
    expect((await cli(["lanes", "get", "nope"])).err).toContain('No lane named "nope"');
  });

  it("updates settings, keeping the address, and merges attachment options", async () => {
    const lane = await createLane(db, { slug: "a", attachment_policy: { allowed_types: ["application/pdf"] } });
    await cli(["lanes", "update", "a", "--shareable", "--retention-days", "30"]);
    let now = (await getLaneBySlug(db, "a"))!;
    expect(now).toMatchObject({ shareable: true, retentionDays: 30, addressToken: lane.addressToken });
    expect(now.attachmentPolicy.allowed_types).toEqual(["application/pdf"]);

    await cli(["lanes", "update", "a", "--no-shareable", "--unzip-secret", "LANE_SECRET_Z", "--inner-type", "application/pdf"]);
    now = (await getLaneBySlug(db, "a"))!;
    expect(now.shareable).toBe(false);
    expect(now.attachmentPolicy.transforms).toHaveLength(1);
    expect(now.attachmentPolicy.allowed_types).toEqual(["application/pdf"]);

    await cli(["lanes", "update", "a", "--no-unzip"]);
    expect((await getLaneBySlug(db, "a"))!.attachmentPolicy.transforms).toEqual([]);

    await createLane(db, { slug: "b", allowed_senders: ["x@example.com"] });
    await cli(["lanes", "update", "b", "--clear-allowed-senders"]);
    expect((await getLaneBySlug(db, "b"))!.allowedSenders).toBeNull();
    expect((await cli(["lanes", "update", "a"])).err).toContain("Nothing to update");
  });

  it("pauses and resumes", async () => {
    await createLane(db, { slug: "a" });
    await cli(["lanes", "pause", "a"]);
    expect((await getLaneBySlug(db, "a"))!.status).toBe("paused");
    await cli(["lanes", "resume", "a"]);
    expect((await getLaneBySlug(db, "a"))!.status).toBe("active");
  });
});

describe("destructive commands", () => {
  it("refuse without a terminal or --yes, and change nothing", async () => {
    const lane = await createLane(db, { slug: "a" });
    const { agent } = await createAgent(db, "bot");
    await seedMessage(lane);
    for (const args of [["lanes", "delete", "a"], ["lanes", "rotate", "a"], ["agents", "revoke", "bot"], ["messages", "delete", "01HZ0000000000000000000001"]]) {
      const r = await cli(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toContain("--yes");
    }
    expect((await getLaneBySlug(db, "a"))!.addressToken).toBe(lane.addressToken);
    expect(await db.first("SELECT id FROM agents WHERE revoked_at IS NULL AND id = ?", [agent.id])).not.toBeNull();
    expect(await db.all("SELECT id FROM messages WHERE deleted_at IS NULL")).toHaveLength(1);
  });

  it("ask on a terminal and respect the answer", async () => {
    await createLane(db, { slug: "a" });
    const no = await cli(["lanes", "delete", "a"], { tty: true, confirm: false });
    expect(no.code).toBe(1);
    expect(no.err).toContain("Cancelled");
    expect(no.asked[0]).toContain("Deleting lane");
    expect(await getLaneBySlug(db, "a")).not.toBeNull();
    const yes = await cli(["lanes", "delete", "a"], { tty: true, confirm: true });
    expect(yes.code).toBe(0);
    expect(await getLaneBySlug(db, "a")).toBeNull();
  });

  it("--yes skips the prompt: rotate prints the new address", async () => {
    const lane = await createLane(db, { slug: "a" });
    const r = await cli(["lanes", "rotate", "a", "--yes"]);
    const after = (await getLaneBySlug(db, "a"))!;
    expect(after.addressToken).not.toBe(lane.addressToken);
    expect(r.out).toContain(`inbox+${after.addressToken}@mail.example.com`);
    expect(r.asked).toEqual([]);
  });

  it("deleting a lane soft-deletes its messages and keeps the rejection log", async () => {
    const lane = await createLane(db, { slug: "a" });
    await seedMessage(lane);
    await logRejection(db, { bucket: "lane", recipientHint: "x", envelopeFrom: "a@example.com", headerFrom: null, reason: "auth_failed", laneId: lane.id }, 50);
    await cli(["lanes", "delete", "a", "--yes"]);
    expect(await db.all("SELECT id FROM messages WHERE deleted_at IS NULL")).toHaveLength(0);
    expect(await db.all("SELECT id FROM rejections")).toHaveLength(1);
  });
});

describe("agents", () => {
  it("refuses to mint without an interactive terminal, so tokens cannot be captured", async () => {
    for (const args of [["agents", "mint", "bot"], ["--json", "agents", "mint", "bot"]]) {
      const r = await cli(args, { tty: false });
      expect(r.code).toBe(1);
      expect(r.err).toContain("interactive terminal");
    }
    const json = await cli(["--json", "agents", "mint", "bot"], { tty: true });
    expect(json.code).toBe(1);
    expect(await getAgentByName(db, "bot")).toBeNull();
  });

  it("mints in a terminal, prints the token once, stores only its hash, and never shows it again", async () => {
    const r = await cli(["agents", "mint", "bot"], { tty: true });
    expect(r.code).toBe(0);
    const token = r.out.match(/aia_[a-z2-7]{52}/)?.[0];
    expect(token).toMatch(AGENT_TOKEN_PATTERN);
    const row = await db.first<{ token_hash: string }>("SELECT token_hash FROM agents WHERE name = 'bot'");
    expect(row!.token_hash).toBe(await sha256Hex(token!));
    const list = await cli(["agents", "list"]);
    const all = [list.all, (await cli(["--json", "agents", "list"])).all].join("\n");
    expect(all).not.toContain(token);
    expect(all).not.toContain(row!.token_hash);
  });

  it("grants, ungrants and revokes", async () => {
    const lane = await createLane(db, { slug: "receipts" });
    await createAgent(db, "bot");
    await cli(["agents", "grant", "bot", "receipts"]);
    expect((await cli(["agents", "list"])).out).toMatch(/bot\s+active\s+\S+\s+receipts/);
    const agent = (await getAgentByName(db, "bot"))!;
    await seedMessage(lane);
    expect(await listMessagesForAgent(db, agent.id)).toHaveLength(1);

    await cli(["agents", "ungrant", "bot", "receipts"]);
    expect(await listMessagesForAgent(db, agent.id)).toHaveLength(0);

    await cli(["agents", "revoke", "bot", "--yes"]);
    expect((await cli(["agents", "list"])).out).toContain("revoked");
    expect((await cli(["agents", "grant", "bot", "receipts"])).err).toContain("revoked");
    expect((await cli(["agents", "grant", "ghost", "receipts"])).err).toContain('No agent named "ghost"');
  });
});

describe("secrets", () => {
  it("reads the value from stdin and sets it without printing it", async () => {
    const r = await cli(["secrets", "set", "LANE_SECRET_INV"], { stdin: "hunter2-value\n" });
    expect(r.code).toBe(0);
    expect(setSecret).toHaveBeenCalledWith("LANE_SECRET_INV", "hunter2-value");
    expect(r.all).not.toContain("hunter2-value");
  });

  it("prompts without echo on a terminal", async () => {
    const r = await cli(["secrets", "set", "LANE_SECRET_INV"], { tty: true, secret: "typed-value" });
    expect(setSecret).toHaveBeenCalledWith("LANE_SECRET_INV", "typed-value");
    expect(r.all).not.toContain("typed-value");
    expect(r.asked[0]).toContain("hidden");
  });

  it("only sets lane secrets, and refuses an empty value or a value in an argument", async () => {
    expect((await cli(["secrets", "set", "CLOUDFLARE_API_TOKEN"], { stdin: "x" })).code).toBe(1);
    expect((await cli(["secrets", "set", "LANE_SECRET_X"], { stdin: "\n" })).err).toContain("empty");
    expect((await cli(["secrets", "set", "LANE_SECRET_X", "value-as-argument"])).code).toBe(1);
    expect(setSecret).not.toHaveBeenCalled();
  });
});

describe("messages", () => {
  let lane: Lane;
  const ID = "01HZ0000000000000000000001";
  beforeEach(async () => {
    lane = await createLane(db, { slug: "receipts" });
    await seedMessage(lane);
  });

  it("lists metadata and gets a message without its body by default", async () => {
    const list = await cli(["messages", "list"]);
    expect(list.out).toContain(ID);
    expect(list.out).toContain("sender@example.com");
    expect(list.out).toContain("1 transform error(s)");
    const get = await cli(["messages", "get", ID]);
    expect(get.out).toContain("dkim=pass header.d=example.com");
    expect(get.out).toContain("TRANSFORM ERROR: archive could not be read");
    expect(get.out).toContain("Body not shown");
  });

  it("never prints a message body unless --show-body is passed", async () => {
    await createAgent(db, "bot");
    await createShare(db, `att-${ID}`, "bot", 10);
    const everything: string[][] = [
      ["lanes", "list"], ["lanes", "get", "receipts"], ["agents", "list"], ["rejections", "list"],
      ["messages", "list"], ["messages", "list", "--lane", "receipts"], ["messages", "get", ID],
      ["messages", "mark-unprocessed", ID], ["messages", "keep", ID], ["messages", "keep", ID, "--off"],
    ];
    for (const args of everything) {
      for (const json of [false, true]) {
        const r = await cli(json ? ["--json", ...args] : args);
        expect(r.all, `${json ? "--json " : ""}${args.join(" ")}`).not.toContain(SENTINEL);
      }
    }
    const shown = await cli(["messages", "get", ID, "--show-body"]);
    expect(shown.out).toContain(SENTINEL);
    expect(shown.out).toContain("untrusted");
    expect(JSON.parse((await cli(["--json", "messages", "get", ID, "--show-body"])).out).untrusted_body).toBe(SENTINEL);
    expect(JSON.parse((await cli(["--json", "messages", "get", ID])).out)).not.toHaveProperty("untrusted_body");
  });

  it("neutralises terminal escapes and invisible characters in untrusted fields", async () => {
    await seedMessage(lane, "01HZ0000000000000000000002", { subject: "\u001b[2J\u001b[31mRED‮evil​\nsecond line" });
    for (const args of [["messages", "list"], ["messages", "get", "01HZ0000000000000000000002"], ["--json", "messages", "list"]]) {
      const r = await cli(args);
      expect(r.all).not.toMatch(/[\u001b‮​]/);
      expect(r.all).toContain("RED");
    }
    const human = await cli(["messages", "list"]);
    expect(human.out.split("\n").filter((l) => l.includes("RED"))).toHaveLength(1);
  });

  it("marks unprocessed, keeps, and deletes", async () => {
    await db.run("UPDATE messages SET processed_at = '2026-01-02', processed_by = 'bot' WHERE id = ?", [ID]);
    await cli(["messages", "mark-unprocessed", ID]);
    expect((await db.first<{ processed_at: string | null }>("SELECT processed_at FROM messages WHERE id = ?", [ID]))!.processed_at).toBeNull();
    await cli(["messages", "keep", ID]);
    expect((await db.first<{ keep: number }>("SELECT keep FROM messages WHERE id = ?", [ID]))!.keep).toBe(1);
    await cli(["messages", "keep", ID, "--off"]);
    expect((await db.first<{ keep: number }>("SELECT keep FROM messages WHERE id = ?", [ID]))!.keep).toBe(0);
    expect((await cli(["messages", "delete", ID, "--yes"])).code).toBe(0);
    expect((await cli(["messages", "get", ID])).err).toContain("No such message");
    expect((await cli(["messages", "keep", "nope"])).code).toBe(1);
  });

  it("injects a test message that agents see, marked as a test", async () => {
    const { agent } = await createAgent(db, "bot");
    await db.run("INSERT INTO agent_lanes (agent_id, lane_id) VALUES (?, ?)", [agent.id, lane.id]);
    const r = await cli(["messages", "inject-test", "receipts", "--subject", "Test receipt", "--text", "Total 3.50"]);
    expect(r.code).toBe(0);
    const rows = await listMessagesForAgent(db, agent.id, { limit: 10 });
    const injected = rows.find((m) => m.is_test === 1)!;
    expect(injected).toMatchObject({ subject: "Test receipt", clean_text: "Total 3.50", lane_slug: "receipts" });
    expect(injected.envelope_from).toBe("cli-test@example.invalid");
    const piped = await cli(["messages", "inject-test", "receipts", "--stdin"], { stdin: "from stdin​" });
    expect(piped.code).toBe(0);
    expect((await listMessagesForAgent(db, agent.id, { limit: 10 })).some((m) => m.clean_text === "from stdin")).toBe(true);
    expect((await cli(["messages", "inject-test", "nope"])).code).toBe(1);
  });
});

describe("rejections", () => {
  it("lists reasons, lanes and headers only", async () => {
    const lane = await createLane(db, { slug: "receipts" });
    await logRejection(db, { bucket: "lane", recipientHint: "inbox+ab…", envelopeFrom: "x@example.org", headerFrom: "y@example.org", reason: "sender_not_allowed", laneId: lane.id }, 50);
    await logRejection(db, { bucket: "probe", recipientHint: "inbox+cd…", envelopeFrom: "z@example.org", headerFrom: null, reason: "unknown_address" }, 50);
    const r = await cli(["rejections", "list"]);
    expect(r.out).toMatch(/sender_not_allowed\s+receipts/);
    expect(r.out).toMatch(/unknown_address\s+-/);
    expect((await cli(["rejections", "list", "--lane", "receipts"])).out).not.toContain("unknown_address");
    expect(JSON.parse((await cli(["--json", "rejections", "list"])).out)).toHaveLength(2);
    expect(r.out).not.toContain(lane.addressToken);
  });
});

describe("errors", () => {
  it("unknown commands exit non-zero, and help works", async () => {
    expect((await cli(["bogus"])).code).not.toBe(0);
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("lanes");
    expect(help.out).toContain("--show-body");
  });

  it("hides unexpected error detail", async () => {
    const broken = makeCli({ ...db, all: () => Promise.reject(new Error("secret internals: token abc")) } as Db);
    const r = await broken.cli(["lanes", "list"]);
    expect(r.code).toBe(1);
    expect(r.all).not.toContain("secret internals");
  });
});
