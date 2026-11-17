import { configure, Uint8ArrayReader, ZipReader, type Entry, type FileEntry } from "@zip.js/zip.js";
import { MIB } from "../core/lane-config.ts";
import { safeFilename, sniffType } from "../core/sniff.ts";
import type { IngestedAttachment } from "./ingest.ts";

configure({ useWebWorkers: false });

/** Limits sized for the Workers Free plan's CPU and memory. */
export const UNZIP_LIMITS = { maxEntries: 10, maxTotalBytes: 10 * MIB };

export type UnzipResult = { ok: true; files: IngestedAttachment[] } | { ok: false; error: string };

class LimitExceeded extends Error {}

/** Collects an entry's bytes, aborting as soon as the running total passes the limit. */
function limitedSink(remaining: number): { stream: WritableStream<Uint8Array>; bytes: () => Uint8Array } {
  const chunks: Uint8Array[] = [];
  let total = 0;
  return {
    stream: new WritableStream<Uint8Array>({
      write(chunk) {
        total += chunk.byteLength;
        if (total > remaining) throw new LimitExceeded();
        chunks.push(chunk);
      },
    }),
    bytes() {
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }
      return out;
    },
  };
}

const isFile = (e: Entry): e is FileEntry => !e.directory;

/** Unique, safe display names: a.pdf, a-2.pdf, a-3.pdf. */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return used.add(name), name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate)) return used.add(candidate), candidate;
  }
}

/**
 * Extracts a zip, all or nothing. Any violation (too many entries, too much
 * data, a nested archive, an inner type that is not allowed, a wrong password)
 * fails the whole archive. Error text never includes names or the password.
 */
export async function unzip(
  bytes: Uint8Array,
  opts: { password: string | undefined; allowInnerTypes: string[]; maxFiles: number },
): Promise<UnzipResult> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    let entries: Entry[];
    try {
      entries = await reader.getEntries();
    } catch (e) {
      // zip.js itself refuses traversal names while reading the directory.
      return { ok: false, error: /unsafe/i.test(String((e as Error)?.message)) ? "archive contains unsafe paths" : "archive could not be read" };
    }
    const files = entries.filter(isFile);
    if (files.length === 0) return { ok: false, error: "archive contains no files" };
    if (files.length > Math.min(UNZIP_LIMITS.maxEntries, opts.maxFiles)) return { ok: false, error: "archive has too many files" };
    if (files.reduce((sum, e) => sum + e.uncompressedSize, 0) > UNZIP_LIMITS.maxTotalBytes) {
      return { ok: false, error: "archive is too large when decompressed" };
    }
    // Names are only ever used after being made safe, but a traversal attempt is a sign of a hostile archive.
    if (files.some((e) => /(^|[\\/])\.\.([\\/]|$)/.test(e.filename) || /^([\\/]|[A-Za-z]:)/.test(e.filename))) {
      return { ok: false, error: "archive contains unsafe paths" };
    }
    if (files.some((e) => e.encrypted) && !opts.password) return { ok: false, error: "archive is encrypted and no password is configured" };

    const out: IngestedAttachment[] = [];
    const names = new Set<string>();
    let remaining = UNZIP_LIMITS.maxTotalBytes;
    for (const entry of files) {
      const sink = limitedSink(remaining);
      try {
        await entry.getData(sink.stream, { password: opts.password });
      } catch (e) {
        if (e instanceof LimitExceeded) return { ok: false, error: "archive is too large when decompressed" };
        return { ok: false, error: entry.encrypted ? "archive could not be decrypted (wrong password?)" : "archive could not be read" };
      }
      const data = sink.bytes();
      remaining -= data.byteLength;

      const filename = uniqueName(safeFilename(entry.filename, `file-${out.length + 1}`), names);
      const type = sniffType(data, filename);
      if (type === "application/zip") return { ok: false, error: "nested archives are not supported" };
      if (!opts.allowInnerTypes.includes(type)) return { ok: false, error: `inner file type ${type} not allowed` };
      out.push({ filename, type, bytes: data });
    }
    return { ok: true, files: out };
  } finally {
    await reader.close().catch(() => {});
  }
}
