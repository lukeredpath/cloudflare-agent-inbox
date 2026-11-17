// Deterministic conversion of untrusted mail bodies to clean plain text.
// No AI is involved: the same input always gives the same output.

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);
const BLOCK = new Set([
  "p", "div", "br", "hr", "li", "ul", "ol", "tr", "table", "blockquote", "pre", "section", "article", "header",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dt", "dd", "address", "form", "fieldset",
]);
// Content is dropped entirely.
const RAW_SKIP = new Set(["script", "style"]);
const ALWAYS_HIDDEN = new Set(["head", "template", "title", "noscript"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©",
  pound: "£", euro: "€", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·", trade: "™", reg: "®",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g, (whole, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
    return String.fromCodePoint(code);
  });
}

const ZERO = String.raw`0+(?:\.0+)?(?:px|pt|em|rem|%|ex|cm|mm|in|pc|vw|vh)?`;
const HIDING_STYLE = new RegExp(
  [
    String.raw`display\s*:\s*none`,
    String.raw`visibility\s*:\s*(?:hidden|collapse)`,
    String.raw`mso-hide\s*:\s*all`,
    String.raw`opacity\s*:\s*0(?:\.0+)?\s*(?:;|$|!)`,
    String.raw`font-size\s*:\s*${ZERO}\s*(?:;|$|!)`,
    String.raw`(?:^|[;\s])(?:max-)?(?:width|height)\s*:\s*${ZERO}\s*(?:;|$|!)`,
  ].join("|"),
  "i",
);

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*(?:=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?`, "i"));
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

function isHidden(name: string, attrs: string): boolean {
  if (ALWAYS_HIDDEN.has(name)) return true;
  if (attr(attrs, "hidden") !== null) return true;
  const style = attr(attrs, "style");
  return style !== null && HIDING_STYLE.test(decodeEntities(style));
}

function hostnameOf(href: string): string | null {
  try {
    const url = new URL(decodeEntities(href).trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

const URL_LIKE = /^(?:https?:\/\/|www\.)\S+$/i;

/** HTML to text: hidden content, scripts, styles and images are dropped; links become `text (domain)`. */
export function htmlToText(html: string): string {
  const out: string[] = [];
  const stack: { name: string; hidden: boolean; link?: { domain: string; start: number } }[] = [];
  let hiddenDepth = 0;

  const TOKEN = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;

  const emitText = (raw: string) => {
    if (hiddenDepth === 0 && raw) out.push(decodeEntities(raw));
  };
  const breakLine = () => {
    if (hiddenDepth === 0) out.push("\n");
  };

  while ((m = TOKEN.exec(html)) !== null) {
    emitText(html.slice(last, m.index));
    last = TOKEN.lastIndex;
    if (m[0].startsWith("<!--") || m[2] === undefined) continue;

    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const attrs = m[3] ?? "";

    if (!closing) {
      if (RAW_SKIP.has(name)) {
        const end = html.slice(last).search(new RegExp(`</${name}\\b[^>]*>`, "i"));
        if (end === -1) {
          last = html.length;
          TOKEN.lastIndex = html.length;
        } else {
          const close = html.slice(last + end).match(new RegExp(`</${name}\\b[^>]*>`, "i"))![0];
          last = last + end + close.length;
          TOKEN.lastIndex = last;
        }
        continue;
      }
      if (name === "img") continue;
      if (BLOCK.has(name)) breakLine();
      if (name === "li" && hiddenDepth === 0) out.push("- ");
      if (name === "td" || name === "th") emitText(" ");
      if (VOID.has(name)) continue;

      const hidden = isHidden(name, attrs);
      if (hidden) hiddenDepth++;
      const entry: (typeof stack)[number] = { name, hidden };
      if (name === "a") {
        const href = attr(attrs, "href");
        const domain = href ? hostnameOf(href) : null;
        if (domain && hiddenDepth === 0) entry.link = { domain, start: out.length };
      }
      stack.push(entry);
    } else {
      let i = stack.length - 1;
      while (i >= 0 && stack[i]!.name !== name) i--;
      if (i < 0) continue;
      while (stack.length > i) {
        const popped = stack.pop()!;
        if (popped.hidden) hiddenDepth--;
        if (popped.link) {
          const text = out.splice(popped.link.start).join("").replace(/\s+/g, " ").trim();
          const { domain } = popped.link;
          if (!text) out.push(`(${domain})`);
          else if (URL_LIKE.test(text) || text.toLowerCase() === domain) out.push(`(${domain})`);
          else out.push(`${text} (${domain})`);
        }
      }
      if (BLOCK.has(name)) breakLine();
    }
  }
  emitText(html.slice(last));
  return out.join("");
}

/** Bare URLs in plain text become `(domain)`. */
export function reduceLinks(text: string): string {
  return text.replace(/<?\b(https?:\/\/[^\s<>"')\]]+)>?/gi, (whole, url: string) => {
    const domain = hostnameOf(url);
    return domain ? `(${domain})` : whole;
  });
}

// Zero-width, bidi and other invisible format characters, plus Unicode "tag"
// characters, which can smuggle invisible text.
const INVISIBLE =
  /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ﻿ﾠ￹-￻]|[\u{e0000}-\u{e007f}]/gu;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "").replace(CONTROL, "");
}

function collapse(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strip invisibles, NFKC-normalise, collapse whitespace and cap the length. */
export function sanitiseText(text: string, maxChars: number): string {
  const normalised = stripInvisible(stripInvisible(text).normalize("NFKC"));
  let clean = collapse(normalised);
  if (clean.length > maxChars) {
    let cut = clean.slice(0, maxChars);
    if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
    clean = `${cut.trimEnd()}\n[truncated]`;
  }
  return clean;
}

/** Prefer the text/plain part; otherwise convert the HTML part. */
export function bodyToText(body: { text?: string | null; html?: string | null }): string {
  if (body.text && body.text.trim()) return reduceLinks(body.text);
  if (body.html) return htmlToText(body.html);
  return "";
}

export const FORWARDED_MARKER = "--- Forwarded message ---";
