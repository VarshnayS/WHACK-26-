/**
 * src/senses/index.ts: the player's senses (vision, ...)
 // Stub entry point: does nothing yet. Called once from src/main.ts.
 */
import type { World } from '../world';
import { initVision } from './vision';

export function initSenses(world: World): void {
  initVision(world);
}
