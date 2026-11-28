import { createIngestKey, revokeIngestKey } from "../../../core/ingest-keys.ts";
import { getLaneBySlug } from "../../../core/lanes.ts";
import { ApiFailure, json } from "../http.ts";
import type { CreatedIngestKey } from "../types.ts";
import { ingestKeyView } from "../views.ts";
import { SLUG, type ApiContext, type Route } from "./route.ts";

const KEY_ID = "(aik_[a-z2-7]{16})";

async function requireLane(ctx: ApiContext) {
  const lane = await getLaneBySlug(ctx.db, ctx.params[0]!);
  if (!lane) throw new ApiFailure(404, "lane not found");
  return lane;
}

/**
 * HTTP ingest keys, per lane. Listing is part of the lane's detail. Setting up the key pair stays in the
 * CLI (`ingest-keys init`): it writes a Worker secret, which needs a Cloudflare API token the Worker does not hold.
 */
export const ingestKeyRoutes: Route[] = [
  {
    method: "POST",
    pattern: new RegExp(`^/api/lanes/${SLUG}/ingest-keys$`),
    name: "ingest_keys.create",
    handler: async (ctx) => {
      const lane = await requireLane(ctx);
      const { id, secret, createdAt } = await createIngestKey(ctx.db, lane.id);
      const key = ingestKeyView({ id, laneId: lane.id, laneSlug: lane.slug, createdAt, lastUsedAt: null, revokedAt: null });
      // The secret is only ever in this response. The router logs the route name and status, never a body.
      return json(201, { key, secret } satisfies CreatedIngestKey);
    },
  },

  {
    method: "POST",
    pattern: new RegExp(`^/api/lanes/${SLUG}/ingest-keys/${KEY_ID}/revoke$`),
    name: "ingest_keys.revoke",
    handler: async (ctx) => {
      const lane = await requireLane(ctx);
      await revokeIngestKey(ctx.db, ctx.params[1]!, lane.id);
      return json(200, { ok: true });
    },
  },
];
