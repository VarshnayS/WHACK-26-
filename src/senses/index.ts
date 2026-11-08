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
  // Dev builds only: ?fakepad=1 (or ?fakepad=unplugged) adds a virtual controller with an on-screen
  // panel (src/player/dev/fakePad.ts). The import is behind import.meta.env.DEV, so production
  // builds don't contain it.
  if (import.meta.env.DEV) {
    const fake = new URLSearchParams(window.location.search).get('fakepad');
    if (fake !== null && fake !== '0') {
      keepPlayingWhenMouseFreed();
      void import('../player/dev/fakePad').then((m) => m.installFakePad(fake !== 'unplugged'));
    }
  }
}

/**
 * ?fakepad only: the fake pad's panel needs the mouse cursor, so freeing the mouse (Esc) must not
 * open the pause screen. Registered after PointerLockControls' own listener (initController ran
 * first) and before src/game/flow.ts's (initFlow runs after initSenses), so the controls still see
 * the unlock but the pause doesn't.
 */
function keepPlayingWhenMouseFreed(): void {
  document.addEventListener('pointerlockchange', (e) => {
    if (!document.pointerLockElement) e.stopImmediatePropagation();
  });
}
