import { json } from "../http.ts";
import type { SessionView } from "../types.ts";
import type { Route } from "./route.ts";

export const sessionRoutes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/session$/,
    name: "session",
    handler: (ctx) => json(200, { email: ctx.identity.email } satisfies SessionView),
  },
];
