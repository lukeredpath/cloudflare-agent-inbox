import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

export interface ZipFile {
  name: string;
  content: Uint8Array | string;
}

export async function makeZip(
  files: ZipFile[],
  opts: { password?: string; mode?: "zipcrypto" | "aes" } = {},
): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    password: opts.password,
    zipCrypto: opts.mode === "zipcrypto",
    ...(opts.password && opts.mode !== "zipcrypto" ? { encryptionStrength: 3 as const } : {}),
  });
  for (const f of files) {
    const bytes = typeof f.content === "string" ? new TextEncoder().encode(f.content) : f.content;
    await writer.add(f.name, new Uint8ArrayReader(bytes));
  }
  return writer.close();
}

