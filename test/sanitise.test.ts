import { describe, expect, it } from "vitest";
import { bodyToText, htmlToText, reduceLinks, sanitiseText, stripInvisible } from "../src/core/sanitise";
import hiddenFixture from "./fixtures/html-hidden.eml?raw";

describe("htmlToText", () => {
  it("drops script, style and head", () => {
    const out = htmlToText("<head><title>T</title><style>p{}</style></head><body><script>evil()</script><p>Hi</p></body>");
    expect(out.trim()).toBe("Hi");
  });

  it.each([
    ['display:none', '<div style="display:none">X</div>'],
    ["visibility:hidden", '<span style="visibility:hidden">X</span>'],
    ["zero font size", '<p style="font-size:0">X</p>'],
    ["zero font size px", '<p style="font-size: 0px !important">X</p>'],
    ["zero width", '<div style="width:0;overflow:hidden">X</div>'],
    ["zero height", '<div style="height:0px">X</div>'],
    ["hidden attribute", "<div hidden>X</div>"],
    ["mso-hide", '<div style="mso-hide:all">X</div>'],
    ["opacity 0", '<div style="opacity:0">X</div>'],
  ])("drops hidden content: %s", (_name, html) => {
    expect(htmlToText(`<p>keep</p>${html}<p>after</p>`)).not.toContain("X");
    expect(htmlToText(`<p>keep</p>${html}<p>after</p>`)).toContain("after");
  });

  it("drops everything nested inside a hidden element, however deep", () => {
    expect(htmlToText('<div style="display:none"><p><b>X</b></p><div>Y</div></div>done').trim()).toBe("done");
  });

  it("keeps visible content with benign styles", () => {
    expect(htmlToText('<p style="font-size:14px;min-width:0">ok</p>').trim()).toBe("ok");
    expect(htmlToText('<p style="width:100px">ok</p>').trim()).toBe("ok");
  });

  it("does not let an unclosed hidden element swallow the rest forever without cause", () => {
    // Unclosed hidden element hides what follows: failing closed is intended.
    expect(htmlToText('<div style="display:none">X<p>after</p>').trim()).toBe("");
  });

  it("reduces links to text (domain) and drops images", () => {
    expect(htmlToText('<a href="https://shop.example.net/track?id=1&x=2">Track order</a>')).toBe("Track order (shop.example.net)");
    expect(htmlToText('<a href="https://shop.example.net/x">https://shop.example.net/x</a>')).toBe("(shop.example.net)");
    expect(htmlToText('<a href="https://shop.example.net/x"><img src="a.png" alt="Logo"></a>')).toBe("(shop.example.net)");
    expect(htmlToText('<a href="javascript:alert(1)">click</a>')).toBe("click");
    expect(htmlToText('<img src="https://t.example.net/pixel.gif" alt="tracking">text')).toBe("text");
  });

  it("decodes entities once", () => {
    expect(htmlToText("<p>Tom &amp; Jerry &lt;b&gt; &#163;5 &#x1F600; &nbsp;x</p>").trim()).toBe("Tom & Jerry <b> £5 😀  x");
    expect(htmlToText("&amp;lt;")).toBe("&lt;");
  });

  it("separates blocks and renders list items", () => {
    expect(htmlToText("<p>a</p><p>b</p><ul><li>one</li><li>two</li></ul>")).toMatch(/a\n+b\n+- one\n+- two/);
  });

  it("survives malformed HTML", () => {
    expect(() => htmlToText("<div<p>><a href=>x</b></i><!-- unterminated")).not.toThrow();
  });
});

describe("plain text", () => {
  it("reduces bare URLs to their domain", () => {
    expect(reduceLinks("See https://shop.example.net/a/b?utm=1 and <https://other.example.org/z>.")).toBe(
      "See (shop.example.net) and (other.example.org).",
    );
  });

  it("prefers text/plain over html", () => {
    expect(bodyToText({ text: "plain", html: "<p>html</p>" })).toBe("plain");
    expect(bodyToText({ text: "  ", html: "<p>html</p>" }).trim()).toBe("html");
    expect(bodyToText({})).toBe("");
  });
});

describe("sanitiseText", () => {
  it("strips zero-width, bidi and tag characters", () => {
    const tagged = "hi" + String.fromCodePoint(0xe0041, 0xe0042) + "there";
    expect(sanitiseText("a\u200Bb\u200Ec\u202Ed\u2066e\uFEFFf\u00ADg", 100)).toBe("abcdefg");
    expect(sanitiseText(tagged, 100)).toBe("hithere");
  });

  it("strips control characters but keeps newlines and tabs as whitespace", () => {
    expect(sanitiseText("a\u0000b\u0007c\u001b[31md\ne", 100)).toBe("abc[31md\ne");
  });

  it("NFKC-normalises look-alikes", () => {
    expect(sanitiseText("ＩＧＮＯＲＥ ﬁle ①", 100)).toBe("IGNORE file 1");
  });

  it("collapses whitespace", () => {
    expect(sanitiseText("a   b\t\tc\r\n\r\n\r\n\r\nd  \n  e", 100)).toBe("a b c\n\nd\ne");
  });

  it("caps length without splitting a surrogate pair, and says so", () => {
    const out = sanitiseText("a" + "😀".repeat(10), 2);
    expect(out.endsWith("\n[truncated]")).toBe(true);
    expect(out).not.toMatch(/[\ud800-\udbff]\n/);
    expect(sanitiseText("short", 100)).toBe("short");
  });

  it("is deterministic", () => {
    const input = "Mixed\u200B <b>input</b> ＡＢＣ";
    expect(sanitiseText(input, 100)).toBe(sanitiseText(input, 100));
  });

  it("stripInvisible alone is idempotent", () => {
    const once = stripInvisible("a\u200Bb");
    expect(stripInvisible(once)).toBe(once);
  });
});

describe("hidden-text fixture", () => {
  it("only the visible text survives", () => {
    const html = hiddenFixture.split(/\r?\n\r?\n/).slice(1).join("\n\n");
    const out = sanitiseText(htmlToText(html), 1000);
    expect(out).toContain("Total: 12.50 GBP");
    expect(out).toContain("Visible footer");
    expect(out).not.toMatch(/SECRET|Hidden title|alert/);
  });
});
