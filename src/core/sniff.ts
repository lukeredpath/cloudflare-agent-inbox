const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((b, i) => bytes[offset + i] === b);

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(sample);
    return true;
  } catch {
    // A multi-byte character may be cut at the end of the sample.
    try {
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(sample.subarray(0, Math.max(0, sample.length - 3)));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The type a file really is, from its bytes. Declared MIME types are only
 * consulted to tell csv from other text. Anything unrecognised is
 * application/octet-stream, which a lane must allow explicitly.
 */
export function sniffType(bytes: Uint8Array, filename: string, declared?: string): string {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return "application/zip";
  // The signature must be at the start of the file (allowing a byte-order mark and a little
  // leading whitespace), not just somewhere near it: a file that merely contains the string
  // early on is a polyglot, not a PDF.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (/^(?:\u00ef\u00bb\u00bf)?[\s\0]{0,8}%PDF-/.test(head)) return "application/pdf";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (looksLikeText(bytes)) {
    return /\.csv$/i.test(filename) || declared?.toLowerCase() === "text/csv" ? "text/csv" : "text/plain";
  }
  return "application/octet-stream";
}

const INVISIBLE_IN_NAME = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** A name that is safe in an object key, a header and a terminal. */
export function safeFilename(name: string | null | undefined, fallback: string): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKC")
    .replace(INVISIBLE_IN_NAME, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return cleaned.replace(/_+$/, "") ? cleaned : fallback;
}
