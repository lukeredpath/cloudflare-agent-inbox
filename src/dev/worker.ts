/**
 * Local development entry only: it is never referenced by the deployed config.
 *
 * It runs the real Worker, including the real Access check, and stands in for Cloudflare Access:
 * a throwaway key pair signs a token for requests to `localhost`, and the public key is served
 * where the Worker looks for Access's keys. Requests for any other host pass through untouched.
 */
import type { Env } from "../worker/env.ts";
import worker from "../worker/index.ts";

const DEV_HOST = "localhost";
const KEY_ID = "dev";

const pair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const publicJwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: KEY_ID };

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/cdn-cgi/access/certs")) return Promise.resolve(Response.json({ keys: [publicJwk] }));
  return realFetch(input, init);
}) as typeof fetch;

const b64url = (data: string | ArrayBuffer) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function devToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", kid: KEY_ID, typ: "JWT" }));
  const body = b64url(
    JSON.stringify({ iss: `https://${env.ACCESS_TEAM_DOMAIN}`, aud: [env.ACCESS_AUD], email: "dev@example.com", iat: now, nbf: now - 5, exp: now + 3600 }),
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

export default {
  ...worker,
  async fetch(request, env, ctx): Promise<Response> {
    if (new URL(request.url).hostname !== DEV_HOST || env.ADMIN_HOSTNAME !== DEV_HOST) return worker.fetch!(request, env, ctx);
    const headers = new Headers(request.headers);
    headers.set("cf-access-jwt-assertion", await devToken(env));
    return worker.fetch!(new Request(request, { headers }), env, ctx);
  },
} satisfies ExportedHandler<Env>;
