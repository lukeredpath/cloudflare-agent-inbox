import { ZodError } from "zod";
import { CoreError } from "../../core/lanes.ts";
import type { ApiError } from "./types.ts";

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

export const fail = (status: number, error: string, extra: Partial<ApiError> = {}, headers?: Record<string, string>) =>
  json(status, { error, ...extra } satisfies ApiError, headers);

/** Thrown by handlers for a response that is not a success; turned into JSON by the router. */
export class ApiFailure extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY_CHARS = 64 * 1024;

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new ApiFailure(413, "request too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiFailure(400, "invalid JSON");
  }
}

/**
 * Maps what handlers throw onto responses. Messages are fixed text or come from the core's own
 * validation (which never echoes message content), so nothing from an email or the deployment is
 * reflected; anything unexpected is a plain 500.
 */
export function failureResponse(e: unknown): Response | null {
  if (e instanceof ApiFailure) return fail(e.status, e.message);
  if (e instanceof ZodError) {
    return fail(400, "invalid", { issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  if (e instanceof CoreError) {
    const status = /not found/i.test(e.message) ? 404 : /already exists/i.test(e.message) ? 409 : 400;
    return fail(status, e.message);
  }
  return null;
}
