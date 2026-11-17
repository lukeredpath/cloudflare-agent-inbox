export interface ScanFile {
  path: string;
  content: string;
}

export interface Hit {
  path: string;
  /** 1-based line number, or 0 when the match is in the path itself. */
  line: number;
  /** 1-based position of the matching denylist entry. The term is never reported. */
  entry: number;
}

export function parseDenylist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Case-insensitive search of paths and contents for any denylist term. */
export function scan(files: ScanFile[], denylist: string[]): Hit[] {
  const terms = denylist.map((t) => t.toLowerCase());
  const hits: Hit[] = [];
  for (const file of files) {
    const path = file.path.toLowerCase();
    terms.forEach((term, i) => {
      if (path.includes(term)) hits.push({ path: file.path, line: 0, entry: i + 1 });
    });
    file.content.split("\n").forEach((text, n) => {
      const lower = text.toLowerCase();
      terms.forEach((term, i) => {
        if (lower.includes(term)) hits.push({ path: file.path, line: n + 1, entry: i + 1 });
      });
    });
  }
  return hits;
}
