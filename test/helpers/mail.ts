import { env } from "cloudflare:test";
import { buildAddress } from "../../src/core/address";
import type { Lane } from "../../src/core/lanes";
import type { Env } from "../../src/worker/env";
import worker from "../../src/worker/index";

export const MAIL_HOST = "mail.example.com";

export const testEnv = (overrides: Record<string, unknown> = {}): Env => ({ ...(env as unknown as Env), ...overrides }) as Env;

export interface TestMessage extends ForwardableEmailMessage {
  /** The reason passed to setReject, or null if the message was not rejected. */
  rejected: string | null;
}

/** An inbound message as Email Routing would hand it to the Worker. */
export function makeMessage(raw: Uint8Array, opts: { from?: string; to: string }): TestMessage {
  const head = new TextDecoder().decode(raw).split(/\r?\n\r?\n/, 1)[0] ?? "";
  const headers = new Headers();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers.append(line.slice(0, i), line.slice(i + 1).trim());
  }
  const message = {
    from: opts.from ?? "sender@example.com",
    to: opts.to,
    headers,
    raw: new Blob([raw]).stream(),
    rawSize: raw.byteLength,
    canBeForwarded: false,
    rejected: null as string | null,
    setReject(reason: string) {
      message.rejected = reason;
    },
    forward: async () => ({ messageId: "x" }),
    reply: async () => ({ messageId: "x" }),
  };
  return message as unknown as TestMessage;
}

export const laneAddress = (lane: Lane) => buildAddress(lane.addressToken, MAIL_HOST);

/** Calls the Worker's fetch handler as the platform would. */
export const workerFetch = (url: string, init?: RequestInit): Promise<Response> =>
  worker.fetch(new Request(url, init) as unknown as Request<unknown, IncomingRequestCfProperties>, testEnv(), {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext);
