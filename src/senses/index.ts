/**
 * src/senses/index.ts: the player's senses (vision, footsteps, cane), plus controller input and
 * haptics (src/player/gamepad.ts, src/player/haptics.ts). Called once from src/main.ts.
 */
import type { World } from '../world';
import { initVision } from './vision';
import { initFootsteps } from './footsteps';
import { initCane } from './cane';
import { initGamepad } from '../player/gamepad';
import { initHaptics } from '../player/haptics';

export function initSenses(world: World): void {
  initVision(world);
  initFootsteps(world);
  initCane(world);
  initGamepad();
  initHaptics();
}
