import { d1Db } from "../core/db.ts";
import { resolveShare } from "../core/shares.ts";
import { SHARE_TOKEN_PATTERN } from "../core/tokens.ts";
import type { Env } from "./env.ts";
import { logEvent } from "./log.ts";

const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });

/** GET /s/<token>: streams one shared attachment while its link is unexpired. */
export async function handleShare(request: Request, env: Env): Promise<Response> {
  const match = /^\/s\/([^/]+)$/.exec(new URL(request.url).pathname);
  if (request.method !== "GET" || !match || !SHARE_TOKEN_PATTERN.test(match[1]!)) return notFound();

  const share = await resolveShare(d1Db(env.DB), match[1]!);
  if (!share) {
    logEvent("share", { outcome: "not_found" });
    return notFound();
  }
  const object = await env.BUCKET.get(share.r2_key);
  if (!object) {
    logEvent("share", { outcome: "missing_object", attachment: share.attachment_id, agent: share.agent_id }, "warn");
    return notFound();
  }
  // Who used the link, never the link itself.
  logEvent("share", { outcome: "served", attachment: share.attachment_id, agent: share.agent_id, bytes: object.size });

  return new Response(object.body, {
    headers: {
      "content-type": share.content_type,
      "content-length": String(object.size),
      // The filename was made safe at ingest, so it needs no quoting rules.
      "content-disposition": `attachment; filename="${share.filename}"`,
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}
