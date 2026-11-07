/**
 * src/world/agentMaterial.ts: the sonar material for agents (pedestrians, cars)
 * Owner: @USERNAME_A (world/tiles/agents)
 *
 * Agents use the ONE shared sonar shader (src/render/sonarMaterial.ts) with an object-space grid, so
 * lines travel with the limbs instead of sliding over them, and InstancedMesh works (one draw call per
 * body part for all pedestrians). Same uniforms as the tiles, so every ping style, the red impact
 * colour, vision modes and reveal-all (R) apply to agents exactly as to the street.
 */
import type * as THREE from 'three';
import { GRID_SIZE } from '../config';
import { createSonarMaterial } from '../render/sonarMaterial';

/**
 * A sonar material for agents. `gridSize` is the line spacing in metres on the object (people get a
 * finer grid than tiles so a 0.2 m head still shows lines; cars use the world grid size).
 * Create one per spacing and share it.
 */
export function createAgentMaterial(name: string, gridSize: number = GRID_SIZE): THREE.ShaderMaterial {
  return createSonarMaterial({ name, gridSpace: 'object', gridSize });
}

/** Grid spacing on people (m): fine enough to read on a hand-sized limb. */
export const PERSON_GRID_SIZE = 0.1;
/** Grid spacing on cars (m). */
export const CAR_GRID_SIZE = 0.25;
