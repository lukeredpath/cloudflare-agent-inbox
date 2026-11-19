import { getLaneBySlug } from "../../../core/lanes.ts";
import { listRejections } from "../../../core/rejections.ts";
import { ApiFailure, json } from "../http.ts";
import { rejectionView } from "../views.ts";
import type { Route } from "./route.ts";

export const rejectionRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/rejections$/,
    name: "rejections.list",
    handler: async (ctx) => {
      const limit = Number(ctx.url.searchParams.get("limit") ?? 200);
      if (!Number.isInteger(limit) || limit < 1) throw new ApiFailure(400, "invalid limit");
      let laneId: string | undefined;
      const slug = ctx.url.searchParams.get("lane");
      if (slug) {
        const lane = await getLaneBySlug(ctx.db, slug);
        if (!lane) throw new ApiFailure(404, "lane not found");
        laneId = lane.id;
      }
      return json(200, (await listRejections(ctx.db, { laneId, limit })).map(rejectionView));
    },
  },
];
