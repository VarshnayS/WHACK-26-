/**
 * src/world/debugKeys.ts: world debug keys + a small debug readout
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 *   R      reveal all (debug grid on every tile/agent, no sonar mask)
 *   F      free-fly debug camera (see debugCamera.ts)
 *
 * (The old Space test ping is gone: the mic module in src/audio/ owns Space now.)
 *
 * The readout (top-left, only while R or F is on) shows the camera position, where it is in the
 * corridor and whether tiles are still loading, which helps while warming the tile cache, plus an
 * FPS counter. While R is on, the corridor walls are drawn as a white outline. The readout is a
 * separate element from the HUD (owner C) and never covers the attribution.
 */
import { world } from './index';
import { isRevealAll, onRevealAllChange, toggleRevealAll } from './debugMaterial';
import { initDebugCamera, isDebugCameraActive, toggleDebugCamera } from './debugCamera';
import { getGroundOffset, getTileStats } from './tiles';
import { createPlayAreaOutline, isInsidePlayArea, toCorridor } from './playArea';
import { CORRIDOR_HALF_WIDTH, CORRIDOR_LENGTH } from '../config';

let initialised = false;
let readout: HTMLDivElement | null = null;
let readoutTimer = 0;
let frames = 0;
let fps = 0;
let fpsWindowStart = performance.now();

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
  const { along, across } = toCorridor(p);
  const tiles = getTileStats();
  readout.textContent =
    `DEBUG  ${isRevealAll() ? '[R] reveal all  ' : ''}${isDebugCameraActive() ? '[F] free-fly' : ''}   ${fps.toFixed(0)} fps\n` +
    `pos x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)}  (+x west, +z north)\n` +
    `corridor along ${along.toFixed(0)} / ±${CORRIDOR_LENGTH / 2} m  across ${across.toFixed(0)} / ±${CORRIDOR_HALF_WIDTH} m` +
    `${isInsidePlayArea(p) ? '' : '  OUTSIDE WALLS'}\n` +
    `tiles visible ${tiles.visible}  loading ${tiles.loading ? 'yes' : 'no'}  ground offset ${getGroundOffset().toFixed(2)} m\n` +
    `agents ${world.agents.length}  pings ${world.pings.length}`;
}

/** Install the debug keys, free-fly camera and readout. Called once from initTiles(). */
export function initWorldDebug(): void {
  if (initialised) return;
  initialised = true;
  initDebugCamera();
  window.addEventListener('keydown', onKeyDown);
  const outline = createPlayAreaOutline();
  world.scene.add(outline);
  onRevealAllChange((on) => {
    outline.visible = on;
    updateReadout(true);
  });
  world.onUpdate(() => {
    frames++;
    const now = performance.now();
    if (now - fpsWindowStart >= 1000) {
      fps = (frames * 1000) / (now - fpsWindowStart);
      frames = 0;
      fpsWindowStart = now;
    }
    updateReadout();
  });
}
