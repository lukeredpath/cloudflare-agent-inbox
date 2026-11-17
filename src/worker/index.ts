import { handleEmail } from "./email.ts";
import type { Env } from "./env.ts";

export default {
  async email(message, env, _ctx): Promise<void> {
    await handleEmail(message, env);
  },

  async fetch(_request, _env, _ctx): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, _env, _ctx): Promise<void> {},
} satisfies ExportedHandler<Env>;
