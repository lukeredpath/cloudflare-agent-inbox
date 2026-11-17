import { describe, expect, it } from "vitest";
import { safeFilename, sniffType } from "../src/core/sniff";

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

describe("sniffType", () => {
  it("recognises types from content, ignoring the declared type", () => {
    expect(sniffType(bytes(0x50, 0x4b, 0x03, 0x04, 0), "a.bin", "application/pdf")).toBe("application/zip");
    expect(sniffType(text("%PDF-1.7\n"), "a.txt", "text/plain")).toBe("application/pdf");
    expect(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "a", "text/plain")).toBe("image/png");
    expect(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0), "a", undefined)).toBe("image/jpeg");
    expect(sniffType(text("GIF89a...."), "a", undefined)).toBe("image/gif");
  });

  it("does not trust a pdf label on text", () => {
    expect(sniffType(text("just words"), "invoice.pdf", "application/pdf")).toBe("text/plain");
  });

  it("separates csv from text and treats unknown binary as octet-stream", () => {
    expect(sniffType(text("a,b\n1,2\n"), "data.csv", undefined)).toBe("text/csv");
    expect(sniffType(text("a,b"), "x", "text/csv")).toBe("text/csv");
    expect(sniffType(bytes(0, 1, 2, 3, 0xff, 0xfe), "x.exe", "application/pdf")).toBe("application/octet-stream");
  });

  it("accepts multi-byte text cut at the sample boundary", () => {
    expect(sniffType(text("é".repeat(5000)), "a.txt", undefined)).toBe("text/plain");
  });
});

describe("safeFilename", () => {
  it("keeps a safe basename and replaces everything else", () => {
    expect(safeFilename("Invoice 2026 (final).pdf", "x")).toBe("Invoice_2026__final_.pdf");
    expect(safeFilename("../../etc/passwd", "x")).toBe("passwd");
    expect(safeFilename("C:\\temp\\a.pdf", "x")).toBe("a.pdf");
    expect(safeFilename(".hidden", "x")).toBe("hidden");
    expect(safeFilename("\u202Egnp.exe", "x")).toBe("gnp.exe");
  });
  it("falls back when nothing usable is left", () => {
    expect(safeFilename("", "fallback")).toBe("fallback");
    expect(safeFilename(null, "fallback")).toBe("fallback");
    expect(safeFilename("???", "fallback")).toBe("fallback");
  });
  it("caps the length", () => {
    expect(safeFilename("a".repeat(500) + ".pdf", "x").length).toBeLessThanOrEqual(100);
  });
});

describe("sniffType: PDF signature must be at the start (R6)", () => {
  const bytesOf = (s: string) => new TextEncoder().encode(s);

  it("rejects a file that only contains the signature somewhere near the start", () => {
    const polyglot = bytesOf("<html><script>alert(1)</script>" + " ".repeat(150) + "%PDF-1.4 hidden in the first kilobyte");
    expect(sniffType(polyglot, "a.pdf", "application/pdf")).toBe("text/plain");
    expect(sniffType(bytesOf("GET / HTTP/1.1\n%PDF-1.7"), "a.pdf", undefined)).toBe("text/plain");
  });

  it("still accepts a real PDF, with a byte-order mark or a little leading whitespace", () => {
    expect(sniffType(bytesOf("%PDF-1.7\n%\u00e2\u00e3"), "a.pdf", undefined)).toBe("application/pdf");
    expect(sniffType(bytesOf("\n\n%PDF-1.4\n"), "a.pdf", undefined)).toBe("application/pdf");
    expect(sniffType(new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf("%PDF-1.4")]), "a.pdf", undefined)).toBe("application/pdf");
  });

  it("does not skip more than a few bytes of padding", () => {
    expect(sniffType(bytesOf(" ".repeat(40) + "%PDF-1.4"), "a.pdf", undefined)).toBe("text/plain");
  });
});
