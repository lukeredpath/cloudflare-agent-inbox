export interface Header {
  /** Lower-cased. */
  name: string;
  /** Unfolded and trimmed. */
  value: string;
}

const MAX_HEADER_BYTES = 65536;

/** The header block of a raw message (first 64 KB, up to the first blank line), unfolded. */
export function parseHeaders(raw: Uint8Array): Header[] {
  const text = new TextDecoder().decode(raw.subarray(0, Math.min(raw.byteLength, MAX_HEADER_BYTES)));
  const block = text.split(/\r?\n\r?\n/, 1)[0] ?? "";
  return block
    .replace(/\r?\n[ \t]+/g, " ")
    .split(/\r?\n/)
    .flatMap((line) => {
      const i = line.indexOf(":");
      return i > 0 ? [{ name: line.slice(0, i).trim().toLowerCase(), value: line.slice(i + 1).trim() }] : [];
    });
}
