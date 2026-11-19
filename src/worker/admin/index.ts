import type { Env } from "../env.ts";
import { logEvent } from "../log.ts";
import { verifyAccessJwt } from "./access.ts";
import { handleApi } from "./api.ts";

/**
 * No inline script or style, no third-party origins, no framing. The app is one script and one
 * stylesheet served from this origin, talking to this origin.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

function secured(response: Response): Response {
  const out = new Response(response.body, response);
  out.headers.set("content-security-policy", CSP);
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("x-frame-options", "DENY");
  out.headers.set("referrer-policy", "no-referrer");
  out.headers.set("cross-origin-opener-policy", "same-origin");
  out.headers.set("cross-origin-resource-policy", "same-origin");
  out.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  out.headers.set("x-robots-tag", "noindex, nofollow");
  return out;
}

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** Everything on the admin host: the Access check first, then the JSON API or the app's files. */
async function serve(request: Request, env: Env): Promise<Response> {
  // Fail closed: without both settings nothing on this host is served.
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    logEvent("admin", { outcome: "not_configured" }, "warn");
    return text(503, "The admin interface is not configured.");
  }

  const access = await verifyAccessJwt(request.headers.get("cf-access-jwt-assertion"), {
    teamDomain: env.ACCESS_TEAM_DOMAIN.toLowerCase(),
    audience: env.ACCESS_AUD,
  });
  if (!access.ok) {
    logEvent("admin", { outcome: "access_denied", reason: access.reason }, access.reason === "keys_unavailable" ? "error" : "warn");
    return access.reason === "keys_unavailable" ? text(503, "Unavailable.") : text(403, "Forbidden.");
  }

  const { pathname } = new URL(request.url);
  if (pathname === "/api" || pathname.startsWith("/api/")) return handleApi(request, env, access.identity);

  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "Method not allowed.");
  if (!env.ASSETS) {
    logEvent("admin", { outcome: "no_assets" }, "error");
    return text(503, "The admin interface is not built.");
  }
  return env.ASSETS.fetch(request);
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  return secured(await serve(request, env));
}
