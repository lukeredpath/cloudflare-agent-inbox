import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/core/db";
import {
  getIngestPublicKey,
  importIngestPrivateKey,
  INGEST_KEY_ID_PATTERN,
  INGEST_SECRET_PATTERN,
  listIngestKeys,
  openSecret,
} from "../src/core/ingest-keys";
import { createLane } from "../src/core/lanes";
import { freshDb } from "./helpers/db";
import { makeCli } from "./helpers/cli";

let db: Db;
let cli: ReturnType<typeof makeCli>["cli"];
let setSecret: ReturnType<typeof makeCli>["setSecret"];

beforeEach(async () => {
  db = await freshDb();
  ({ cli, setSecret } = makeCli(db));
  await createLane(db, { slug: "bills" });
});

const privateKeySet = () => setSecret.mock.calls.filter(([name]) => name === "INGEST_PRIVATE_KEY").map(([, value]) => value);

describe("ingest-keys", () => {
  it("init sends the private key to the Worker, keeps the public key in D1, and prints neither", async () => {
    const run = await cli(["ingest-keys", "init"]);
    expect(run.code).toBe(0);
    const [privateJwk] = privateKeySet();
    expect(JSON.parse(privateJwk!)).toMatchObject({ kty: "EC", crv: "P-256", d: expect.any(String) });
    const publicJwk = JSON.parse((await getIngestPublicKey(db))!);
    expect(publicJwk.d).toBeUndefined();
    expect(run.all).not.toContain(JSON.parse(privateJwk!).d);
    expect(run.all).not.toContain(publicJwk.x);
  });

  it("init does nothing when already set up, and --replace revokes every key after confirmation", async () => {
    await cli(["ingest-keys", "init"]);
    await cli(["ingest-keys", "create", "bills"], { tty: true });
    expect((await cli(["ingest-keys", "init"])).out).toContain("already set up");
    expect(privateKeySet()).toHaveLength(1);

    const refused = await cli(["ingest-keys", "init", "--replace"]);
    expect(refused.code).toBe(1);
    expect(privateKeySet()).toHaveLength(1);

    const replaced = await cli(["ingest-keys", "init", "--replace"], { tty: true, confirm: true });
    expect(replaced.code).toBe(0);
    expect(privateKeySet()).toHaveLength(2);
    expect((await listIngestKeys(db)).every((k) => k.revokedAt)).toBe(true);
  });

  it("create needs init first", async () => {
    const run = await cli(["ingest-keys", "create", "bills"], { tty: true });
    expect(run.code).toBe(1);
    expect(run.err).toContain("ingest-keys init");
  });

  it("create prints the secret once, only in an interactive terminal, and only the Worker's key opens it", async () => {
    await cli(["ingest-keys", "init"]);
    for (const refused of [await cli(["ingest-keys", "create", "bills"]), await cli(["--json", "ingest-keys", "create", "bills"], { tty: true })]) {
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("interactive terminal");
    }
    expect(await listIngestKeys(db)).toHaveLength(0);

    const run = await cli(["ingest-keys", "create", "bills"], { tty: true });
    expect(run.code).toBe(0);
    const secret = /ais_[a-z2-7]{52}/.exec(run.out)?.[0];
    const id = /aik_[a-z2-7]{16}/.exec(run.out)?.[0];
    expect(secret).toMatch(INGEST_SECRET_PATTERN);
    expect(id).toMatch(INGEST_KEY_ID_PATTERN);

    const [row] = await db.all<{ id: string; lane_id: string; secret_box: string }>("SELECT id, lane_id, secret_box FROM ingest_keys");
    const workerKey = await importIngestPrivateKey(privateKeySet()[0]!);
    expect(await openSecret(workerKey, row!.secret_box, row!.id, row!.lane_id)).toBe(secret);

    const list = await cli(["ingest-keys", "list"]);
    expect(list.out).toContain(id!);
    expect(list.out).toContain("bills");
    expect(list.out).toContain("never");
    expect(list.all).not.toContain(secret!);
  });

  it("create refuses unknown lanes", async () => {
    await cli(["ingest-keys", "init"]);
    expect((await cli(["ingest-keys", "create", "nope"], { tty: true })).err).toContain('No lane named "nope"');
  });

  it("revoke needs confirmation and disables the key", async () => {
    await cli(["ingest-keys", "init"]);
    await cli(["ingest-keys", "create", "bills"], { tty: true });
    const [key] = await listIngestKeys(db);
    expect((await cli(["ingest-keys", "revoke", key!.id])).code).toBe(1);
    const run = await cli(["ingest-keys", "revoke", key!.id, "--yes"]);
    expect(run.code).toBe(0);
    expect((await listIngestKeys(db))[0]!.revokedAt).not.toBeNull();
    expect((await cli(["ingest-keys", "revoke", key!.id, "--yes"])).err).toContain("already revoked");
  });
});
