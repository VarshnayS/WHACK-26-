/**
 * src/world/debugKeys.ts: world debug keys + a small debug readout
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 *   R      reveal all (debug grid on every tile/agent, no sonar mask)
 *   F      free-fly debug camera (see debugCamera.ts)
 *   Space  test ping: world.ping(camera position, TEST_PING_RANGE)
 *
 * Space is a stand-in until the player controller / mic (owner C) fire pings. When C binds
 * Space in src/player/controller.ts, delete the Space handler here so it doesn't ping twice.
 *
 * The readout (top-left, only while R or F is on) shows the camera position, height and distance
 * from the origin, which helps while warming the tile cache. It's a separate element from the
 * HUD (owner C) and never covers the attribution.
 */
import { world } from './index';
import { isRevealAll, onRevealAllChange, toggleRevealAll } from './debugMaterial';
import { initDebugCamera, isDebugCameraActive, toggleDebugCamera } from './debugCamera';
import { getGroundOffset, getTileStats } from './tiles';
import { PLAY_RADIUS, TEST_PING_RANGE } from '../config';

let initialised = false;
let readout: HTMLDivElement | null = null;
let readoutTimer = 0;

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.repeat || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.code) {
    case 'KeyR':
      toggleRevealAll();
      console.info(`[debug] reveal all ${isRevealAll() ? 'ON' : 'OFF'}`);
      break;
    case 'KeyF':
      toggleDebugCamera();
      console.info(
        `[debug] free-fly camera ${isDebugCameraActive() ? 'ON (click to look, WASD, E/Q up/down, Shift fast, G eye height)' : 'OFF'}`,
      );
      break;
    case 'Space':
      e.preventDefault();
      world.ping(world.camera.position, TEST_PING_RANGE);
      break;
    default:
      return;
  }
  updateReadout(true);
}

function updateReadout(force = false): void {
  const visible = isRevealAll() || isDebugCameraActive();
  if (!visible) {
    if (readout) readout.style.display = 'none';
    return;
  }
  if (!readout) {
    readout = document.createElement('div');
    readout.style.cssText =
      'position:fixed;left:8px;top:8px;z-index:10;pointer-events:none;color:#fff;' +
      'font:12px/1.4 ui-monospace,monospace;white-space:pre;background:rgba(0,0,0,.6);padding:4px 6px;';
    document.body.appendChild(readout);
  }
  readout.style.display = 'block';
  if (!force && performance.now() - readoutTimer < 200) return;
  readoutTimer = performance.now();

  const p = world.camera.position;
  const dist = Math.hypot(p.x, p.z);
  const tiles = getTileStats();
  readout.textContent =
    `DEBUG  ${isRevealAll() ? '[R] reveal all  ' : ''}${isDebugCameraActive() ? '[F] free-fly' : ''}\n` +
    `pos x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)}  (+x west, +z north)\n` +
    `from origin ${dist.toFixed(0)} m${dist > PLAY_RADIUS ? '  OUTSIDE PLAY_RADIUS' : ''}\n` +
    `tiles visible ${tiles.visible}  loading ${tiles.loading ? 'yes' : 'no'}  ground offset ${getGroundOffset().toFixed(2)} m\n` +
    `agents ${world.agents.length}  pings ${world.pings.length}`;
}

/** Install the debug keys, free-fly camera and readout. Called once from initTiles(). */
export function initWorldDebug(): void {
  if (initialised) return;
  initialised = true;
  initDebugCamera();
  window.addEventListener('keydown', onKeyDown);
  onRevealAllChange(() => updateReadout(true));
  world.onUpdate(() => updateReadout());
}
