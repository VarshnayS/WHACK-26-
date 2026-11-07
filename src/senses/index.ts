/**
 * src/senses/index.ts: the player's senses (vision, footsteps, ...). Called once from src/main.ts.
 */
import type { World } from '../world';
import { initVision } from './vision';
import { initFootsteps } from './footsteps';

export function initSenses(world: World): void {
  initVision(world);
  initFootsteps(world);
}
