import { z } from "zod";
import { AGENT_NAME_PATTERN, createAgent, getAgentByName, grantLane, listAgents, revokeAgent } from "../../../core/agents.ts";
import { getLaneBySlug } from "../../../core/lanes.ts";
import { ApiFailure, json, readJson } from "../http.ts";
import { agentView } from "../views.ts";
import { AGENT_NAME, type Route } from "./route.ts";

const CreateBody = z.strictObject({
  name: z.string().regex(AGENT_NAME_PATTERN, "Use letters, digits, dot, dash and underscore (max 40)"),
  lanes: z.array(z.string()).max(100).default([]),
});

export const agentRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/agents$/,
    name: "agents.list",
    handler: async (ctx) => json(200, (await listAgents(ctx.db)).map((a) => agentView(a, a.lanes))),
  },

  {
    method: "POST",
    pattern: /^\/api\/agents$/,
    name: "agents.create",
    handler: async (ctx) => {
      const body = CreateBody.parse(await readJson(ctx.request));
      // Resolve every lane first, so a typo does not leave an agent half set up.
      const lanes = [];
      for (const slug of new Set(body.lanes)) {
        const lane = await getLaneBySlug(ctx.db, slug);
        if (!lane) throw new ApiFailure(400, `No lane named "${slug}"`);
        lanes.push(lane);
      }
      const { agent, token } = await createAgent(ctx.db, body.name);
      for (const lane of lanes) await grantLane(ctx.db, agent.id, lane.id);
      // The token is only ever in this response: only its hash is stored.
      return json(201, { agent: agentView(agent, lanes.map((l) => l.slug)), token });
    },
  },

  {
    method: "POST",
    pattern: new RegExp(`^/api/agents/${AGENT_NAME}/revoke$`),
    name: "agents.revoke",
    handler: async (ctx) => {
      const agent = await getAgentByName(ctx.db, ctx.params[0]!);
      if (!agent) throw new ApiFailure(404, "agent not found");
      await revokeAgent(ctx.db, agent.id);
      return json(200, { ok: true });
    },
  },
];
