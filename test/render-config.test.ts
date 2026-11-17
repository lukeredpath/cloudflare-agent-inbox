import { describe, expect, it } from "vitest";
import { renderConfig } from "../scripts/render-config";
import exampleTemplate from "../wrangler.example.jsonc?raw";

const template = `{
  // comment without tokens
  "name": "<WORKER_NAME>",
  "main": "src/worker/index.ts",
  "vars": { "HOST": "<MAIL_HOSTNAME>", "AGAIN": "<MAIL_HOSTNAME>" }
}`;

const env = {
  AGENT_INBOX_WORKER_NAME: "agent-inbox",
  AGENT_INBOX_MAIL_HOSTNAME: "mail.example.com",
};

describe("renderConfig", () => {
  it("substitutes every token, including repeats", () => {
    const out = renderConfig(template, env);
    expect(out).toContain('"name": "agent-inbox"');
    expect(out.match(/mail\.example\.com/g)).toHaveLength(2);
    expect(out).not.toMatch(/<[A-Z_]+>/);
  });

  it("names every missing variable", () => {
    expect(() => renderConfig(template, { AGENT_INBOX_WORKER_NAME: "x" })).toThrow(
      "Missing build variables: AGENT_INBOX_MAIL_HOSTNAME",
    );
    expect(() => renderConfig(template, {})).toThrow(
      "AGENT_INBOX_WORKER_NAME, AGENT_INBOX_MAIL_HOSTNAME",
    );
  });

  it("treats an empty value as missing", () => {
    expect(() => renderConfig(template, { ...env, AGENT_INBOX_WORKER_NAME: "" })).toThrow("Missing");
  });

  it("rejects values that could break out of a JSON string", () => {
    expect(() => renderConfig(template, { ...env, AGENT_INBOX_WORKER_NAME: 'a","x":"b' })).toThrow(
      "Unsupported characters in: AGENT_INBOX_WORKER_NAME",
    );
  });

  it("rejects a value that smuggles in a placeholder-like token", () => {
    // Angle brackets are outside the safe set, so this is caught as unsupported.
    expect(() => renderConfig(template, { ...env, AGENT_INBOX_WORKER_NAME: "<OTHER>" })).toThrow();
  });

  it("never echoes values in error messages", () => {
    const secret = "very-private-value.example.org";
    try {
      renderConfig(template, { AGENT_INBOX_WORKER_NAME: secret });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(secret);
    }
    try {
      renderConfig(template, { ...env, AGENT_INBOX_WORKER_NAME: `${secret}"` });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(secret);
    }
  });

  it("relocates main for a config rendered into a subdirectory", () => {
    const out = renderConfig(template, env, { relocateMainBy: "../" });
    expect(out).toContain('"main": "../src/worker/index.ts"');
  });
});

describe("wrangler.example.jsonc", () => {
  it("renders to valid JSONC once every variable is supplied", () => {
    const names = [...new Set([...exampleTemplate.matchAll(/<([A-Z][A-Z0-9_]*)>/g)].map((m) => m[1]!))];
    expect(names.length).toBeGreaterThan(0);
    const vars = Object.fromEntries(names.map((n) => [`AGENT_INBOX_${n}`, "value.example.com"]));
    const out = renderConfig(exampleTemplate, vars, { relocateMainBy: "../" });
    expect(out).not.toMatch(/<[A-Z][A-Z0-9_]*>/);
    expect(out).toContain('"main": "../src/worker/index.ts"');
    expect(out).toContain('"migrations_dir": "../migrations"');
  });
});
