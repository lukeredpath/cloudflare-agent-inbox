import type { ApiError } from "../worker/admin/types.ts";

export class ApiRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Talks to the Worker's JSON API. Changes always send JSON; the Worker refuses anything else. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // Never follow an Access login redirect in the background: it cannot be shown.
      redirect: "manual",
    });
  } catch {
    throw new ApiRequestError(0, "Could not reach the server.");
  }
  if (res.type === "opaqueredirect") throw new ApiRequestError(401, "Your session has ended. Reload the page to sign in again.");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(res.status, body?.error ?? `Request failed (${res.status}).`);
  }
  return (await res.json()) as T;
}
