/**
 * src/game/flow.ts: game flow (main menu -> playing -> paused / dead -> main menu)
 *
 * Called once from src/main.ts as initFlow(world), AFTER initEntity.
 *
 *   menu     main menu (the start screen, src/hud/startScreen.ts) is up; nothing is simulated once the
 *            game has begun at least once (the first load keeps updating so the loading gate works)
 *   playing  normal play
 *   paused   Esc (mouse unlocked while playing): Resume / Quit to Menu
 *   dead     'caught': freeze, fade audio + scene to black, then the audit report with a
 *            "Return to Main Menu" button
 *
 * "Frozen" means main.ts skips runUpdates() (isSimulationRunning() is false). Rendering keeps going
 * so the audit report can still capture the scene; the fade to black is a CSS overlay.
 *
 * Nothing in src/world/audit/ is edited. The report has no open/close API (only the V key), so we
 * open/close it by dispatching a V keydown and detect it by its DOM node (fixed, z-index 1000).
 */
import type { World } from '../world';
import { EYE_HEIGHT } from '../config';
import { getPlayerController } from '../player/controller';
import { sampleGround } from '../world/heightField';
import { resetAgents } from '../world/agents';
import { isDebugCameraActive, setDebugCamera } from '../world/debugCamera';
import { resetEntity, setEntityEnabled } from '../entity';
import { getListener } from '../entity/audio';
import { fadeSoundscape } from '../audio/soundscape';
import { isOverlayOpen, onMenuBegin, reopenMainMenu } from '../hud/startScreen';
import { onSettingsChange, settings } from './settings';

export type GameState = 'menu' | 'playing' | 'paused' | 'dead';

/** Seconds for the death fade (audio and scene). */
const DEATH_FADE_S = 1.6;
/** Seconds for the pause / resume / menu audio fades. */
const QUICK_FADE_S = 0.3;
/** Seconds audio takes to come back when a run begins. */
const BEGIN_FADE_S = 0.8;

const Z_BLACKOUT = 29; // above the canvas and HUD, below the start screen (30) and attribution (31)
const Z_PAUSE = 1500;
const Z_BUTTONS = 2000; // above the audit report (1000)

let world: World;
let state: GameState = 'menu';
/** False until the first "Click to begin": until then the world keeps updating (loading gate). */
let hasBegun = false;
let deathTimer = 0;

export function getGameState(): GameState {
  return state;
}

/** main.ts runs the per-frame updates only while this is true. */
export function isSimulationRunning(): boolean {
  return !hasBegun || state === 'playing';
}

// --- small DOM helpers ---------------------------------------------------------------------------

const BTN_CSS =
  'font:14px system-ui,sans-serif;padding:8px 18px;background:#000;color:#fff;border:1px solid #fff;' +
  'border-radius:4px;cursor:pointer;pointer-events:auto;';

function button(text: string, onClick: () => void, css = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.style.cssText = BTN_CSS + css;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
    b.blur(); // so Space / Enter don't re-trigger it
  });
  return b;
}

let blackout: HTMLDivElement;
let deathText: HTMLDivElement;
let quitButton: HTMLButtonElement;
let returnButton: HTMLButtonElement;
let pauseOverlay: HTMLDivElement;

function buildUi(): void {
  const root = document.getElementById('hud') ?? document.body;

  blackout = document.createElement('div');
  blackout.style.cssText = `position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:${Z_BLACKOUT};`;
  deathText = document.createElement('div');
  deathText.textContent = 'CAUGHT';
  deathText.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#d00;' +
    'font:300 clamp(32px,8vw,72px) system-ui,sans-serif;letter-spacing:0.3em;opacity:0;transition:opacity 0.8s;';
  blackout.appendChild(deathText);

  // Global "Quit to Menu": on every screen except the main menu itself. Top right, under the vision label.
  quitButton = button('Quit to Menu', quitToMenu, `position:fixed;right:8px;top:50px;z-index:${Z_BUTTONS};padding:4px 10px;font-size:12px;display:none;`);

  returnButton = button(
    'Return to Main Menu',
    quitToMenu,
    `position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:${Z_BUTTONS};font-size:16px;padding:10px 28px;display:none;`,
  );

  pauseOverlay = document.createElement('div');
  pauseOverlay.style.cssText =
    `position:fixed;inset:0;z-index:${Z_PAUSE};display:none;flex-direction:column;align-items:center;justify-content:center;` +
    'gap:14px;background:rgba(0,0,0,0.82);color:#fff;font:14px system-ui,sans-serif;pointer-events:auto;';
  const title = document.createElement('div');
  title.textContent = 'Paused';
  title.style.cssText = 'font-size:32px;font-weight:300;letter-spacing:0.08em;';
  pauseOverlay.append(title, button('Resume', resume), button('Quit to Menu', quitToMenu));

  root.append(blackout, pauseOverlay);
  document.body.append(quitButton, returnButton);
}

// --- audio ---------------------------------------------------------------------------------------

/** Fade every sound in the game: the soundscape (own AudioContext) and the entity (three's listener). */
function fadeAudio(level: number, seconds: number): void {
  fadeSoundscape(level, seconds);
  try {
    const gain = getListener(world.camera).gain.gain;
    const ctx = getListener(world.camera).context;
    gain.cancelScheduledValues(ctx.currentTime);
    gain.setValueAtTime(gain.value, ctx.currentTime);
    gain.linearRampToValueAtTime(level, ctx.currentTime + Math.max(0.01, seconds));
  } catch {
    /* no audio listener yet */
  }
}

// --- audit report (no API: V key + DOM node) ----------------------------------------------------

function auditReportEl(): HTMLElement | null {
  for (const el of Array.from(document.body.children)) {
    const s = (el as HTMLElement).style;
    if (s.position === 'fixed' && s.zIndex === '1000') return el as HTMLElement;
  }
  return null;
}

function isReportOpen(): boolean {
  return auditReportEl()?.style.display === 'block';
}

function pressReportKey(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', bubbles: true }));
}

function setReportOpen(open: boolean): void {
  if (isReportOpen() !== open) pressReportKey();
}

// --- player / entity -----------------------------------------------------------------------------

function clearHeldKeys(): void {
  window.dispatchEvent(new Event('blur')); // clears the controller's and the debug camera's held keys
}

/**
 * Back to the start point: ORIGIN_LAT / ORIGIN_LON, which is (0, 0) in local metres. Also clears the
 * stun and any daze effect. (Pedestrians and cars are reset separately: resetWorld().)
 */
function resetPlayer(): void {
  getPlayerController()?.reset();
  const cam = world.camera;
  cam.position.set(0, sampleGround(0, 0) + EYE_HEIGHT, 0);
  cam.rotation.set(0, 0, 0);
}

/** Everything that moves on its own: new pedestrians and cars, the entity respawned far away. */
function resetWorld(): void {
  resetAgents();
  resetEntity();
}

function applyEntitySetting(): void {
  setEntityEnabled(settings.entityEnabled);
}

// --- transitions ---------------------------------------------------------------------------------

function showBlackout(on: boolean, seconds: number): void {
  blackout.style.transition = seconds > 0 ? `opacity ${seconds}s ease-in` : 'none';
  blackout.style.opacity = on ? '1' : '0';
  deathText.style.opacity = on ? '1' : '0';
}

function begin(): void {
  hasBegun = true;
  state = 'playing';
  window.clearTimeout(deathTimer);
  showBlackout(false, 0);
  pauseOverlay.style.display = 'none';
  returnButton.style.display = 'none';
  quitButton.style.display = 'block';
  applyEntitySetting();
  resetPlayer();
  resetWorld();
  getPlayerController()?.setEnabled(true);
  fadeAudio(1, BEGIN_FADE_S);
  // startScreen locks the pointer right after this callback
}

function onCaught(): void {
  if (state !== 'playing') return; // the entity keeps chasing and can fire again after its cooldown
  state = 'dead';
  getPlayerController()?.setEnabled(false); // zeroes velocity and releases the pointer
  clearHeldKeys();
  fadeAudio(0, DEATH_FADE_S);
  showBlackout(true, DEATH_FADE_S);
  deathTimer = window.setTimeout(() => {
    if (state !== 'dead') return;
    setReportOpen(true);
    returnButton.style.display = 'block';
  }, DEATH_FADE_S * 1000 + 200);
}

function openPause(): void {
  state = 'paused';
  getPlayerController()?.setEnabled(false);
  clearHeldKeys();
  fadeAudio(0, QUICK_FADE_S);
  pauseOverlay.style.display = 'flex';
}

function resume(): void {
  if (state !== 'paused') return;
  state = 'playing';
  pauseOverlay.style.display = 'none';
  const c = getPlayerController();
  c?.setEnabled(true);
  fadeAudio(1, QUICK_FADE_S);
  try {
    c?.controls.lock(); // inside the click: allowed
  } catch {
    /* clicking the scene locks it */
  }
}

/** Stop the simulation, put the player back at the origin, reset the entity, show the main menu. */
export function quitToMenu(): void {
  if (state === 'menu') return;
  window.clearTimeout(deathTimer);
  setReportOpen(false);
  state = 'menu';
  pauseOverlay.style.display = 'none';
  returnButton.style.display = 'none';
  quitButton.style.display = 'none';
  showBlackout(false, 0);
  if (isDebugCameraActive()) setDebugCamera(false); // free-fly (F) must not outlive the run
  getPlayerController()?.setEnabled(false);
  clearHeldKeys();
  fadeAudio(0, QUICK_FADE_S);
  resetPlayer();
  resetWorld();
  reopenMainMenu();
}

export function initFlow(w: World): void {
  world = w;
  buildUi();

  onMenuBegin(begin);
  onSettingsChange(applyEntitySetting);
  applyEntitySetting(); // honour the saved setting before the first frame

  world.on('caught', onCaught);

  // Esc: the browser swallows the keydown while the pointer is locked, so detect the unlock instead.
  // Ignore unlocks that are caused by something else (start-screen / vision overlay, audit report, free-fly F).
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement) return;
    if (state !== 'playing' || isOverlayOpen() || isReportOpen() || isDebugCameraActive()) return;
    openPause();
  });

  // Esc on the pause overlay resumes (a keydown does reach the page while unlocked).
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && state === 'paused' && !e.repeat) resume();
  });
}