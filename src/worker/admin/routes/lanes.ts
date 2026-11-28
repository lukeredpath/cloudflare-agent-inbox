import { z } from "zod";
import { listActiveShares, listTransformFailures, laneAgentCounts, rejectionCountsSince, transformFailureCounts } from "../../../core/admin.ts";
import { getAgentByName, grantLane, listAgents, ungrantLane } from "../../../core/agents.ts";
import {
  CoreError,
  createLane,
  deleteLane,
  getLaneBySlug,
  listLanes,
  rotateLaneToken,
  setLaneStatus,
  updateLane,
  type Lane,
  type LaneSummary,
} from "../../../core/lanes.ts";
import { getIngestPublicKey, listIngestKeys, MAX_ACTIVE_KEYS_PER_LANE } from "../../../core/ingest-keys.ts";
import { listMessagesAdmin } from "../../../core/messages.ts";
import { listRejections } from "../../../core/rejections.ts";
import { ApiFailure, json, readJson } from "../http.ts";
import type { LaneDetail, LaneListItem, OverviewView } from "../types.ts";
import { fullAddress, ingestEndpoint, ingestKeyView, laneView, messageItem, rejectionView } from "../views.ts";
import { AGENT_NAME, SLUG, type ApiContext, type Route } from "./route.ts";

const DAY_MS = 86_400_000;

async function requireLane(ctx: ApiContext, slug: string): Promise<Lane> {
  const lane = await getLaneBySlug(ctx.db, slug);
  if (!lane) throw new ApiFailure(404, "lane not found");
  return lane;
}

const listItem = (l: LaneSummary, agents: Map<string, number>): LaneListItem => ({
  slug: l.slug,
  description: l.description,
  status: l.status,
  message_count: l.messageCount,
  unprocessed_count: l.unprocessedCount,
  last_received_at: l.lastReceivedAt,
  agent_count: agents.get(l.id) ?? 0,
});

async function laneList(ctx: ApiContext): Promise<LaneListItem[]> {
  const [lanes, agents] = await Promise.all([listLanes(ctx.db), laneAgentCounts(ctx.db)]);
  return lanes.map((l) => listItem(l, agents));
}

const StatusBody = z.strictObject({ status: z.enum(["active", "paused"]) });

export const laneRoutes: Route[] = [
  { method: "GET", pattern: /^\/api\/lanes$/, name: "lanes.list", handler: async (ctx) => json(200, await laneList(ctx)) },

  {
    method: "GET",
    pattern: /^\/api\/overview$/,
    name: "overview",
    handler: async (ctx) => {
      const [lanes, failures, rejections] = await Promise.all([
        laneList(ctx),
        transformFailureCounts(ctx.db),
        rejectionCountsSince(ctx.db, new Date(Date.now() - 2 * DAY_MS)),
      ]);
      return json(200, { lanes, transform_failures: failures, rejections_48h: rejections } satisfies OverviewView);
    },
  },

  {
    method: "POST",
    pattern: /^\/api\/lanes$/,
    name: "lanes.create",
    handler: async (ctx) => {
      const lane = await createLane(ctx.db, await readJson(ctx.request));
      // The one time the full address comes back with the lane: the person creating it needs it now.
      return json(201, { lane: laneView(lane, ctx.env.MAIL_HOSTNAME), address: fullAddress(lane, ctx.env.MAIL_HOSTNAME) });
    },
  },

  {
    method: "GET",
    pattern: new RegExp(`^/api/lanes/${SLUG}$`),
    name: "lanes.get",
    handler: async (ctx) => {
      const lane = await requireLane(ctx, ctx.params[0]!);
      const [summary, agents, shares, failures, rejections, recent, ingestKeys, ingestPublicKey] = await Promise.all([
        listLanes(ctx.db).then((all) => all.find((l) => l.id === lane.id)),
        listAgents(ctx.db),
        listActiveShares(ctx.db, lane.id),
        listTransformFailures(ctx.db, lane.id),
        listRejections(ctx.db, { laneId: lane.id, limit: 10 }),
        listMessagesAdmin(ctx.db, { laneId: lane.id, limit: 5 }),
        listIngestKeys(ctx.db, lane.id),
        getIngestPublicKey(ctx.db),
      ]);
      const live = agents.filter((a) => !a.revokedAt);
      return json(200, {
        lane: laneView(lane, ctx.env.MAIL_HOSTNAME),
        message_count: summary?.messageCount ?? 0,
        unprocessed_count: summary?.unprocessedCount ?? 0,
        recent_messages: recent.map(messageItem),
        agents: live.filter((a) => a.lanes.includes(lane.slug)).map((a) => a.name),
        grantable_agents: live.filter((a) => !a.lanes.includes(lane.slug)).map((a) => a.name),
        shares: shares.map((s) => ({ agent: s.agent, untrusted_filename: s.attachment_filename, expires_at: s.expires_at, created_at: s.created_at })),
        transform_failures: failures.map((f) => ({
          message_id: f.message_id,
          attachment_id: f.attachment_id,
          received_at: f.received_at,
          untrusted_filename: f.filename,
          untrusted_error: f.transform_error,
        })),
        rejections: rejections.map(rejectionView),
        ingest: {
          ready: ingestPublicKey !== null,
          endpoint: ingestEndpoint(ctx.env, lane.slug),
          max_active_keys: MAX_ACTIVE_KEYS_PER_LANE,
          keys: ingestKeys.map(ingestKeyView),
        },
      } satisfies LaneDetail);
    },
  },

  {
    method: "PATCH",
    pattern: new RegExp(`^/api/lanes/${SLUG}$`),
    name: "lanes.update",
    handler: async (ctx) => {
      const lane = await requireLane(ctx, ctx.params[0]!);
      const updated = await updateLane(ctx.db, lane.id, await readJson(ctx.request));
      return json(200, laneView(updated, ctx.env.MAIL_HOSTNAME));
    },
  },

  {
    method: "DELETE",
    pattern: new RegExp(`^/api/lanes/${SLUG}$`),
    name: "lanes.delete",
    handler: async (ctx) => {
      await deleteLane(ctx.db, (await requireLane(ctx, ctx.params[0]!)).id);
      return json(200, { ok: true });
    },
  },

  {
    method: "PUT",
    pattern: new RegExp(`^/api/lanes/${SLUG}/status$`),
    name: "lanes.status",
    handler: async (ctx) => {
      const lane = await requireLane(ctx, ctx.params[0]!);
      const { status } = StatusBody.parse(await readJson(ctx.request));
      await setLaneStatus(ctx.db, lane.id, status);
      return json(200, { status });
    },
  },

  {
    method: "GET",
    pattern: new RegExp(`^/api/lanes/${SLUG}/address$`),
    name: "lanes.address",
    handler: async (ctx) => json(200, { address: fullAddress(await requireLane(ctx, ctx.params[0]!), ctx.env.MAIL_HOSTNAME) }),
  },

  {
    method: "POST",
    pattern: new RegExp(`^/api/lanes/${SLUG}/rotate$`),
    name: "lanes.rotate",
    handler: async (ctx) => {
      const rotated = await rotateLaneToken(ctx.db, (await requireLane(ctx, ctx.params[0]!)).id);
      return json(200, { address: fullAddress(rotated, ctx.env.MAIL_HOSTNAME) });
    },
  },

  {
    method: "PUT",
    pattern: new RegExp(`^/api/lanes/${SLUG}/grants/${AGENT_NAME}$`),
    name: "grants.add",
    handler: async (ctx) => {
      const lane = await requireLane(ctx, ctx.params[0]!);
      const agent = await getAgentByName(ctx.db, ctx.params[1]!);
      if (!agent) throw new ApiFailure(404, "agent not found");
      if (agent.revokedAt) throw new CoreError("A revoked agent cannot be granted a lane");
      await grantLane(ctx.db, agent.id, lane.id);
      return json(200, { ok: true });
    },
  },

  {
    method: "DELETE",
    pattern: new RegExp(`^/api/lanes/${SLUG}/grants/${AGENT_NAME}$`),
    name: "grants.remove",
    handler: async (ctx) => {
      const lane = await requireLane(ctx, ctx.params[0]!);
      const agent = await getAgentByName(ctx.db, ctx.params[1]!);
      if (!agent) throw new ApiFailure(404, "agent not found");
      await ungrantLane(ctx.db, agent.id, lane.id);
      return json(200, { ok: true });
    },
  },
];
