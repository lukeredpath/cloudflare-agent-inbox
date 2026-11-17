import { describe, expect, it } from "vitest";
import { UNZIP_LIMITS, unzip } from "../src/worker/unzip";
import { PDF_BYTES } from "./helpers/eml";
import { makeZip } from "./helpers/zip";

const opts = (password: string | null = "correct-horse", allowInnerTypes = ["application/pdf"]) => ({
  password: password ?? undefined,
  allowInnerTypes,
  maxFiles: 20,
});

describe("unzip", () => {
  it.each(["zipcrypto", "aes"] as const)("extracts a %s archive with the right password", async (mode) => {
    const zip = await makeZip([{ name: "invoice.pdf", content: PDF_BYTES }], { password: "correct-horse", mode });
    const result = await unzip(zip, opts());
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({ filename: "invoice.pdf", type: "application/pdf" });
      expect([...result.files[0]!.bytes]).toEqual([...PDF_BYTES]);
    }
  });

  it.each(["zipcrypto", "aes"] as const)("fails cleanly on a wrong %s password", async (mode) => {
    const zip = await makeZip([{ name: "invoice.pdf", content: PDF_BYTES }], { password: "correct-horse", mode });
    const result = await unzip(zip, opts("wrong-password"));
    expect(result).toEqual({ ok: false, error: "archive could not be decrypted (wrong password?)" });
  });

  it("fails when the archive is encrypted and no password is configured", async () => {
    const zip = await makeZip([{ name: "a.pdf", content: PDF_BYTES }], { password: "x", mode: "aes" });
    expect(await unzip(zip, opts(null))).toEqual({
      ok: false,
      error: "archive is encrypted and no password is configured",
    });
  });

  it("extracts an unencrypted archive without needing a password", async () => {
    const zip = await makeZip([{ name: "a.pdf", content: PDF_BYTES }]);
    expect(await unzip(zip, opts(null))).toMatchObject({ ok: true });
  });

  it("rejects a zip bomb without holding the output", async () => {
    const zeros = new Uint8Array(UNZIP_LIMITS.maxTotalBytes * 3);
    const zip = await makeZip([{ name: "bomb.pdf", content: zeros }]);
    expect(zip.byteLength).toBeLessThan(200_000);
    const result = await unzip(zip, opts(null, ["application/octet-stream", "application/pdf"]));
    expect(result).toEqual({ ok: false, error: "archive is too large when decompressed" });
  });

  it("rejects when several entries together exceed the total", async () => {
    const chunk = new Uint8Array(UNZIP_LIMITS.maxTotalBytes / 2 + 1024);
    const zip = await makeZip([
      { name: "a.bin", content: chunk },
      { name: "b.bin", content: chunk },
    ]);
    expect(await unzip(zip, opts(null, ["application/octet-stream"]))).toMatchObject({ ok: false });
  });

  it("rejects too many entries", async () => {
    const files = Array.from({ length: UNZIP_LIMITS.maxEntries + 1 }, (_, i) => ({ name: `f${i}.pdf`, content: PDF_BYTES }));
    expect(await unzip(await makeZip(files), opts(null))).toEqual({ ok: false, error: "archive has too many files" });
  });

  it("honours the message-wide file budget", async () => {
    const files = [1, 2, 3].map((i) => ({ name: `f${i}.pdf`, content: PDF_BYTES }));
    expect(await unzip(await makeZip(files), { ...opts(null), maxFiles: 2 })).toEqual({
      ok: false,
      error: "archive has too many files",
    });
  });

  it("rejects nested archives", async () => {
    const inner = await makeZip([{ name: "a.pdf", content: PDF_BYTES }]);
    const outer = await makeZip([{ name: "inner.zip", content: inner }]);
    expect(await unzip(outer, opts(null, ["application/pdf", "application/zip"]))).toEqual({
      ok: false,
      error: "nested archives are not supported",
    });
  });

  it("rejects inner files whose real type is not allowed, whatever they are called", async () => {
    const zip = await makeZip([{ name: "invoice.pdf", content: "this is not a pdf" }]);
    expect(await unzip(zip, opts(null))).toEqual({ ok: false, error: "inner file type text/plain not allowed" });
  });

  it("makes inner names safe and unique", async () => {
    const zip = await makeZip([
      { name: "2026/jan/invoice.pdf", content: PDF_BYTES },
      { name: "2026/feb/invoice.pdf", content: PDF_BYTES },
      { name: "evil name\u202E.pdf", content: PDF_BYTES },
    ]);
    const result = await unzip(zip, opts(null));
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.files.map((f) => f.filename)).toEqual(["invoice.pdf", "invoice-2.pdf", "evil_name.pdf"]);
  });

  it.each(["../../evil.pdf", "/etc/evil.pdf", "a/../../evil.pdf", "C:\\evil.pdf"])("rejects the unsafe path %s", async (name) => {
    const zip = await makeZip([{ name, content: PDF_BYTES }]);
    expect(await unzip(zip, opts(null))).toEqual({ ok: false, error: "archive contains unsafe paths" });
  });

  it("skips directory entries and rejects an archive with no files", async () => {
    expect(await unzip(await makeZip([{ name: "empty/", content: "" }]), opts(null))).toEqual({
      ok: false,
      error: "archive contains no files",
    });
  });

  it("reports an unreadable archive without detail", async () => {
    const garbage = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await unzip(garbage, opts())).toEqual({ ok: false, error: "archive could not be read" });
  });

  it("never puts the password or filenames in an error", async () => {
    const zip = await makeZip([{ name: "secret-name.pdf", content: PDF_BYTES }], { password: "correct-horse", mode: "aes" });
    const result = await unzip(zip, opts("hunter2"));
    expect(JSON.stringify(result)).not.toMatch(/hunter2|correct-horse|secret-name/);
  });
});
