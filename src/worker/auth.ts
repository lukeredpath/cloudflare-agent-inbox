import { findAgentByTokenHash, type Agent } from "../core/agents.ts";
import type { Db } from "../core/db.ts";
import { AGENT_TOKEN_PATTERN, sha256Hex } from "../core/tokens.ts";

/**
 * Returns the agent for a valid, unrevoked bearer token, else null. Only
 * hashes are stored; the lookup is an indexed query on the SHA-256 of the
 * presented token, so there is no secret-dependent comparison to time.
 */
export async function authenticateAgent(db: Db, authHeader: string | null): Promise<Agent | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader?.trim() ?? "");
  const token = match?.[1];
  if (!token || !AGENT_TOKEN_PATTERN.test(token)) return null;
  return findAgentByTokenHash(db, await sha256Hex(token));
}
