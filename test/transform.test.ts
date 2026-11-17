import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/core/db";
import { createLane, type Lane } from "../src/core/lanes";
import { handleEmail } from "../src/worker/email";
import { PDF_BYTES, buildEml, type EmlOptions } from "./helpers/eml";
import { freshDb } from "./helpers/db";
import { laneAddress, makeMessage, testEnv } from "./helpers/mail";
import { makeZip } from "./helpers/zip";
import { env } from "cloudflare:test";

const PASSWORD = "lane-a-password";
const unzipTransform = (secret: string) => ({
  transforms: [{ type: "unzip" as const, password_secret: secret, allow_inner_types: ["application/pdf"] }],
});

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  const bucket = testEnv().BUCKET;
  const listed = await bucket.list();
  if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
});

async function deliverZip(lane: Lane, zip: Uint8Array, secrets: Record<string, string> = {}, extra: EmlOptions = {}) {
  const raw = buildEml({ attachments: [{ filename: "invoice.zip", contentType: "application/zip", content: zip }], ...extra });
  const message = makeMessage(raw, { to: laneAddress(lane) });
  await handleEmail(message, testEnv(secrets));
  return message;
}

const rows = () =>
  db.all<{ id: string; parent_id: string | null; filename: string; content_type: string; transform_error: string | null; r2_key: string }>(
    "SELECT * FROM attachments ORDER BY rowid",
  );

describe("unzip transform on a lane", () => {
  it.each(["zipcrypto", "aes"] as const)("unzips a %s archive with the lane's secret and keeps both copies", async (mode) => {
    const lane = await createLane(db, { slug: "invoices", attachment_policy: unzipTransform("LANE_SECRET_A") });
    const zip = await makeZip([{ name: "bill.pdf", content: PDF_BYTES }], { password: PASSWORD, mode });
    const message = await deliverZip(lane, zip, { LANE_SECRET_A: PASSWORD });
    expect(message.rejected).toBeNull();

    const [parent, child] = await rows();
    expect(parent).toMatchObject({ filename: "invoice.zip", content_type: "application/zip", parent_id: null, transform_error: null });
    expect(child).toMatchObject({ filename: "bill.pdf", content_type: "application/pdf", parent_id: parent!.id, transform_error: null });
    for (const r of [parent!, child!]) expect(await testEnv().BUCKET.head(r.r2_key)).not.toBeNull();
    expect(new Uint8Array(await (await testEnv().BUCKET.get(parent!.r2_key))!.arrayBuffer()).byteLength).toBe(zip.byteLength);
  });

  it("the same zip on a lane without the transform is stored but not unzipped", async () => {
    const plain = await createLane(db, { slug: "plain", attachment_policy: { allowed_types: ["application/zip"] } });
    const zip = await makeZip([{ name: "bill.pdf", content: PDF_BYTES }], { password: PASSWORD, mode: "aes" });
    await deliverZip(plain, zip, { LANE_SECRET_A: PASSWORD });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ filename: "invoice.zip", parent_id: null, transform_error: null });
  });

  it("on a lane that does not accept zips at all, the message is rejected", async () => {
    const strict = await createLane(db, { slug: "strict" });
    await deliverZip(strict, await makeZip([{ name: "bill.pdf", content: PDF_BYTES }]));
    expect(await db.all("SELECT 1 FROM messages")).toHaveLength(0);
    expect(await db.all("SELECT reason FROM rejections")).toEqual([{ reason: "attachment_not_allowed" }]);
  });

  it("a lane only ever uses the secret it names", async () => {
    const a = await createLane(db, { slug: "lane-a", attachment_policy: unzipTransform("LANE_SECRET_A") });
    const b = await createLane(db, { slug: "lane-b", attachment_policy: unzipTransform("LANE_SECRET_B") });
    const secrets = { LANE_SECRET_A: PASSWORD, LANE_SECRET_B: "different" };
    const zip = await makeZip([{ name: "bill.pdf", content: PDF_BYTES }], { password: PASSWORD, mode: "aes" });

    await deliverZip(a, zip, secrets);
    expect((await rows()).map((r) => r.filename)).toEqual(["invoice.zip", "bill.pdf"]);

    await db.run("DELETE FROM attachments");
    await db.run("DELETE FROM messages");
    await deliverZip(b, zip, secrets);
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]!.transform_error).toMatch(/wrong password/);
  });

  it("a failing transform still stores the message, flagged on the attachment", async () => {
    const lane = await createLane(db, { slug: "invoices", attachment_policy: unzipTransform("LANE_SECRET_A") });
    const zip = await makeZip([{ name: "bill.pdf", content: PDF_BYTES }], { password: PASSWORD, mode: "zipcrypto" });
    const message = await deliverZip(lane, zip, { LANE_SECRET_A: "bad-pass-xyz" }, { text: "Your invoice is attached" });
    expect(message.rejected).toBeNull();
    const [msg] = await db.all<{ clean_text: string }>("SELECT clean_text FROM messages");
    expect(msg!.clean_text).toBe("Your invoice is attached");
    const [att] = await rows();
    expect(att).toMatchObject({ filename: "invoice.zip", parent_id: null });
    expect(att!.transform_error).toBeTruthy();
    expect(att!.transform_error).not.toContain("bad-pass-xyz");
  });

  it("flags a missing secret", async () => {
    const lane = await createLane(db, { slug: "invoices", attachment_policy: unzipTransform("LANE_SECRET_UNSET") });
    await deliverZip(lane, await makeZip([{ name: "a.pdf", content: PDF_BYTES }], { password: PASSWORD, mode: "aes" }));
    expect((await rows())[0]!.transform_error).toBe("archive is encrypted and no password is configured");
  });

  it("flags a nested archive, an unexpected inner type and a bomb, each still stored", async () => {
    const lane = await createLane(db, { slug: "invoices", attachment_policy: unzipTransform("LANE_SECRET_A") });
    const inner = await makeZip([{ name: "a.pdf", content: PDF_BYTES }]);
    await deliverZip(lane, await makeZip([{ name: "inner.zip", content: inner }]));
    await deliverZip(lane, await makeZip([{ name: "notes.txt", content: "hello" }]));
    await deliverZip(lane, await makeZip([{ name: "big.pdf", content: new Uint8Array(30 * 1024 * 1024) }]));
    const errors = (await rows()).map((r) => r.transform_error);
    expect(errors).toEqual([
      "nested archives are not supported",
      "inner file type text/plain not allowed",
      "archive is too large when decompressed",
    ]);
  });

  it("never stores the secret", async () => {
    const lane = await createLane(db, { slug: "invoices", attachment_policy: unzipTransform("LANE_SECRET_A") });
    await deliverZip(lane, await makeZip([{ name: "a.pdf", content: PDF_BYTES }], { password: PASSWORD, mode: "aes" }), {
      LANE_SECRET_A: PASSWORD,
    });
    for (const table of ["messages", "attachments", "rejections", "lanes"]) {
      expect(JSON.stringify(await db.all(`SELECT * FROM ${table}`))).not.toContain(PASSWORD);
    }
    void env;
  });
});
