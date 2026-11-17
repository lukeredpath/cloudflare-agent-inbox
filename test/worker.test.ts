import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/worker/env";
import worker from "../src/worker/index";

const testEnv = env as unknown as Env;

describe("worker stub", () => {
  it("returns 404 for any request", async () => {
    const res = await worker.fetch(new Request("https://example.com/anything"), testEnv, createExecutionContext());
    expect(res.status).toBe(404);
  });

  it("drops mail silently", async () => {
    const message = {
      from: "sender@example.com",
      to: "inbox@mail.example.com",
      headers: new Headers(),
      raw: new Blob(["Subject: hi\r\n\r\nbody"]).stream(),
      rawSize: 20,
      setReject() {
        throw new Error("must not reject");
      },
    } as unknown as ForwardableEmailMessage;
    await expect(worker.email(message, testEnv, createExecutionContext())).resolves.toBeUndefined();
  });

  it("has the test bindings", () => {
    expect(testEnv.DB).toBeDefined();
    expect(testEnv.BUCKET).toBeDefined();
  });
});
