import { describe, expect, it } from "vitest";
import { parseDenylist, scan } from "../scripts/pii-scan";

const CANARY = "canary-term-xyz";

describe("parseDenylist", () => {
  it("ignores blanks and comments and trims", () => {
    expect(parseDenylist(`# note\n\n  one  \ntwo\r\n`)).toEqual(["one", "two"]);
  });
});

describe("scan", () => {
  it("catches a planted canary in file contents, case-insensitively", () => {
    const hits = scan([{ path: "src/a.ts", content: `line one\nsee ${CANARY.toUpperCase()} here` }], [CANARY]);
    expect(hits).toEqual([{ path: "src/a.ts", line: 2, entry: 1 }]);
  });

  it("catches a canary in a path", () => {
    const hits = scan([{ path: `docs/${CANARY}.md`, content: "clean" }], ["other", CANARY]);
    expect(hits).toEqual([{ path: `docs/${CANARY}.md`, line: 0, entry: 2 }]);
  });

  it("passes a clean tree", () => {
    expect(scan([{ path: "src/a.ts", content: "nothing to see" }], [CANARY])).toEqual([]);
  });

  it("never includes the term in its report", () => {
    const hits = scan([{ path: "a", content: CANARY }], [CANARY]);
    expect(JSON.stringify(hits)).not.toContain(CANARY);
  });
});
