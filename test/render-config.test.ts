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
    const vars = Object.fromEntries(names.map((n) => [`AGENT_INBOX_${n}`, `${n.toLowerCase().replaceAll("_", "-")}.example.com`]));
    const out = renderConfig(exampleTemplate, vars, { relocateMainBy: "../" });
    expect(out).not.toMatch(/<[A-Z][A-Z0-9_]*>/);
    expect(out).toContain('"main": "../src/worker/index.ts"');
    expect(out).toContain('"migrations_dir": "../migrations"');
    expect(out).toContain('"directory": "../dist/admin"');
  });

  describe("optional admin variables", () => {
    const required = [...new Set([...exampleTemplate.matchAll(/<([A-Z][A-Z0-9_]*)>/g)].map((m) => m[1]!))];
    const base = Object.fromEntries(required.map((n) => [`AGENT_INBOX_${n}`, `${n.toLowerCase().replaceAll("_", "-")}.example.com`]));
    const admin = {
      AGENT_INBOX_ADMIN_HOSTNAME: "admin.example.com",
      AGENT_INBOX_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      AGENT_INBOX_ACCESS_AUD: "example-audience-tag",
    };

    it("drops the admin lines when none of the variables are set", () => {
      const out = renderConfig(exampleTemplate, base);
      expect(out).not.toContain("ADMIN_HOSTNAME");
      expect(out).not.toContain("ACCESS_");
      expect(out).toContain('"binding": "ASSETS"');
    });

    it("includes the admin route and variables when all are set", () => {
      const out = renderConfig(exampleTemplate, { ...base, ...admin });
      expect(out).toContain('"pattern": "admin.example.com"');
      expect(out).toContain('"ADMIN_HOSTNAME": "admin.example.com"');
      expect(out).toContain('"ACCESS_TEAM_DOMAIN": "team.cloudflareaccess.com"');
      expect(out).toContain('"ACCESS_AUD": "example-audience-tag"');
    });

    it("requires all three admin variables or none, naming them without values", () => {
      for (const name of Object.keys(admin)) {
        const partial = Object.fromEntries(Object.entries(admin).filter(([k]) => k !== name));
        expect(() => renderConfig(exampleTemplate, { ...base, ...partial })).toThrow(/Set all of these build variables or none/);
      }
      expect(() => renderConfig(exampleTemplate, { ...base, ...admin, AGENT_INBOX_ACCESS_AUD: "" })).toThrow("none");
      try {
        renderConfig(exampleTemplate, { ...base, AGENT_INBOX_ADMIN_HOSTNAME: "admin.example.com" });
      } catch (e) {
        expect(String((e as Error).message)).not.toContain("admin.example.com");
      }
    });

    it("rejects an admin hostname that repeats another hostname", () => {
      expect(() => renderConfig(exampleTemplate, { ...base, ...admin, AGENT_INBOX_ADMIN_HOSTNAME: base.AGENT_INBOX_MCP_HOSTNAME! })).toThrow(
        "must be a different hostname",
      );
    });

    it("rejects unsafe values for optional variables too", () => {
      expect(() => renderConfig(exampleTemplate, { ...base, ...admin, AGENT_INBOX_ACCESS_AUD: 'x","y":"z' })).toThrow(
        "Unsupported characters in: AGENT_INBOX_ACCESS_AUD",
      );
    });
  });
});
