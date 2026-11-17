import type { Env } from "./env";

// Milestone 1 stub: the handlers exist so the Worker deploys and the test
// harness has something to run. Real behaviour arrives in later milestones.
export default {
  async email(_message, _env, _ctx): Promise<void> {
    // Dropped silently, as every non-paused rejection will be.
  },

  async fetch(_request, _env, _ctx): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, _env, _ctx): Promise<void> {},
} satisfies ExportedHandler<Env>;
