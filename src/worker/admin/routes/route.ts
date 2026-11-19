import type { Db } from "../../../core/db.ts";
import type { Env } from "../../env.ts";
import type { AccessIdentity } from "../access.ts";

export interface ApiContext {
  db: Db;
  env: Env;
  identity: AccessIdentity;
  request: Request;
  url: URL;
  /** The capture groups of the route's pattern, in order. */
  params: string[];
}

export interface Route {
  method: string;
  pattern: RegExp;
  /** Logged for changes, so it names the action and nothing about its target. */
  name: string;
  handler: (ctx: ApiContext) => Promise<Response> | Response;
}

export const SLUG = "([a-z0-9][a-z0-9-]{0,39})";
export const AGENT_NAME = "([A-Za-z0-9][A-Za-z0-9_.-]{0,39})";
export const ID = "([A-Za-z0-9_-]{1,64})";
