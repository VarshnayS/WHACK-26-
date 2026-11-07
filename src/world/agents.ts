/**
 * src/world/agents.ts: pedestrians (capsules) and cars (boxes) on OSM paths/roads
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * STUB: signatures are final, bodies are placeholders.
 */
import type { Agent, AgentType } from './index';
import type { PathGraph } from './osm';

/**
 * Load OSM, build path graphs, spawn agents into world.agentsGroup / world.agents,
 * and register their movement with world.onUpdate().
 *
 * TODO(A): every agent mesh uses the shared sonarMaterial (no per-object materials).
 */
export async function initAgents(): Promise<void> {
  // placeholder
}

/** Spawn one agent on a path graph and return it (already added to world.agents). */
export function spawnAgent(type: AgentType, graph: PathGraph): Agent | null {
  void type;
  void graph;
  return null; // placeholder
}
