import type { Db } from "./db.ts";
import { CoreError } from "./lanes.ts";
import { generateAgentToken, sha256Hex } from "./tokens.ts";
import { ulid } from "./ulid.ts";

export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export interface Agent {
  id: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
}

const fromRow = (r: AgentRow): Agent => ({ id: r.id, name: r.name, createdAt: r.created_at, revokedAt: r.revoked_at });

/** Creates an agent and returns its token. Only the hash is stored, so this is the one chance to see it. */
export async function createAgent(db: Db, name: string): Promise<{ agent: Agent; token: string }> {
  if (!AGENT_NAME_PATTERN.test(name)) throw new CoreError("Agent names use letters, digits, dot, dash and underscore (max 40)");
  const token = generateAgentToken();
  const id = ulid();
  const now = new Date().toISOString();
  try {
    await db.run("INSERT INTO agents (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)", [
      id,
      name,
      await sha256Hex(token),
      now,
    ]);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(String((e as Error).message))) {
      throw new CoreError(`An agent named "${name}" already exists`);
    }
    throw e;
  }
  return { agent: { id, name, createdAt: now, revokedAt: null }, token };
}

export async function getAgentByName(db: Db, name: string): Promise<Agent | null> {
  const row = await db.first<AgentRow>("SELECT id, name, created_at, revoked_at FROM agents WHERE name = ?", [name]);
  return row ? fromRow(row) : null;
}

/** Looks an agent up by the hash of its presented token. Revoked agents never match. */
export async function findAgentByTokenHash(db: Db, hash: string): Promise<Agent | null> {
  const row = await db.first<AgentRow>(
    "SELECT id, name, created_at, revoked_at FROM agents WHERE token_hash = ? AND revoked_at IS NULL",
    [hash],
  );
  return row ? fromRow(row) : null;
}

export interface AgentSummary extends Agent {
  lanes: string[];
}

export async function listAgents(db: Db): Promise<AgentSummary[]> {
  const agents = await db.all<AgentRow>("SELECT id, name, created_at, revoked_at FROM agents ORDER BY name");
  const grants = await db.all<{ agent_id: string; slug: string }>(
    "SELECT al.agent_id, l.slug FROM agent_lanes al JOIN lanes l ON l.id = al.lane_id ORDER BY l.slug",
  );
  return agents.map((a) => ({
    ...fromRow(a),
    lanes: grants.filter((g) => g.agent_id === a.id).map((g) => g.slug),
  }));
}

export async function grantLane(db: Db, agentId: string, laneId: string): Promise<void> {
  await db.run("INSERT OR IGNORE INTO agent_lanes (agent_id, lane_id) VALUES (?, ?)", [agentId, laneId]);
}

export async function ungrantLane(db: Db, agentId: string, laneId: string): Promise<void> {
  await db.run("DELETE FROM agent_lanes WHERE agent_id = ? AND lane_id = ?", [agentId, laneId]);
}

/** Revokes the token. Takes effect on the agent's next call. */
export async function revokeAgent(db: Db, agentId: string): Promise<void> {
  const { changes } = await db.run("UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [
    new Date().toISOString(),
    agentId,
  ]);
  if (changes === 0) throw new CoreError("Agent not found or already revoked");
}
