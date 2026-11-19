import type { ApiError } from "../worker/admin/types.ts";
import { createStore } from "./store.ts";

export class ApiRequestError extends Error {
  status: number;
  issues: { path: string; message: string }[];
  constructor(status: number, message: string, issues: { path: string; message: string }[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

/** True once a request found the Access session gone; every screen shows a banner until the page is reloaded. */
export const sessionExpired = createStore(false);

/** Talks to the Worker's JSON API. Changes always send JSON from this origin; the Worker refuses anything else. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const hasBody = init.body !== undefined;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      // Changes carry a content type even without a body: the Worker requires it.
      headers: method === "GET" ? undefined : { "content-type": "application/json" },
      body: hasBody ? JSON.stringify(init.body) : undefined,
      // Never follow an Access login redirect in the background: it cannot be shown.
      redirect: "manual",
    });
  } catch {
    throw new ApiRequestError(0, "Could not reach the server.");
  }
  if (res.type === "opaqueredirect" || res.status === 401) {
    sessionExpired.set(true);
    throw new ApiRequestError(401, "Your session has ended. Sign in again to continue.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(res.status, body?.error ?? `Request failed (${res.status}).`, body?.issues);
  }
  return (await res.json()) as T;
}

export const put = <T = unknown>(path: string, body?: unknown) => api<T>(path, { method: "PUT", body });
export const post = <T = unknown>(path: string, body?: unknown) => api<T>(path, { method: "POST", body });
export const patch = <T = unknown>(path: string, body?: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T = unknown>(path: string) => api<T>(path, { method: "DELETE" });
