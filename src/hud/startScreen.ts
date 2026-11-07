/**
 * src/hud/startScreen.ts: start screen, loading gate, vision overlay (O) and startup timing
 * Owner: SENSES (HUD)
 *
 * START: an opaque white-on-black screen (title, "Click to begin", one line of controls, the vision
 * picker) hides the load. Behind it we wait for: OSM agents spawned, tiles loaded
 * (3d-tiles-renderer loadProgress = 1) and the ground height grid built from those tiles
 * (src/world/heightField.ts). Meanwhile the grid builds in loading mode (big per-frame budget, short
 * settle wait), since nobody is playing yet. "Click to begin" starts the audio engine (startAudio, inside the click: autoplay
 * rule) and locks the pointer. If loading stalls (e.g. an offline cache miss), begin is allowed
 * anyway after BEGIN_ANYWAY_S.
 *
 * ROUTE: a top-down map (src/hud/routePicker.ts, the audit report's snapshot) to place the start and
 * goal; begin puts the player on the start facing the goal (src/player/route.ts).
 *
 * O (in game): reopens the vision picker over the game; click Resume (or O again) to go back.
 *
 * Controller: while one is connected, a small controls overlay (built from PAD_BINDINGS in
 * src/player/gamepadConfig.ts) shows under the keyboard controls line.
 *
 * Startup timing: performance marks from agents / tiles / ground plus long tasks are logged once as
 * `[startup] ...` when the world is ready; getStartupReport() returns the same numbers.
 */
import { world } from '../world';
import { startAudio } from '../audio';
import { getPlayerController } from '../player/controller';
import { getTileStats } from '../world/tiles';
import { groundStatus, setGroundLoading } from '../world/heightField';
import { initVision } from '../senses/vision';
import { createVisionPicker } from '../senses/visionPicker';
import { PAD_BINDINGS, PAD_HELD, type PadButton } from '../player/gamepadConfig';
import { createRoutePicker, initGoalMessage } from './routePicker';
import { applyRouteStart } from '../player/route';

/** Everything must stay ready this long before "Click to begin" lights up (ms): tiles can restart loading. */
const READY_HOLD_MS = 400;
/** After this long, begin is allowed even if loading never finished (s). */
const BEGIN_ANYWAY_S = 30;
/** Loading bar weights. */
const W_AGENTS = 0.1;
const W_TILES = 0.6;
const W_GROUND = 0.3;

export interface StartupReport {
  /** ms since navigation start, or null if it never happened. */
  hudInit: number;
  osmLoaded: number | null;
  agentsReady: number | null;
  firstTile: number | null;
  tilesLoaded: number | null;
  groundBuildStart: number | null;
  groundReady: number | null;
  ready: number | null;
  begin: number | null;
  tileRequests: number;
  /** Main-thread tasks over 50 ms before ready: count, total and the largest (ms). */
  longTasks: { count: number; totalMs: number; largest: { start: number; duration: number }[] };
}

const report: StartupReport = {
  hudInit: 0,
  osmLoaded: null,
  agentsReady: null,
  firstTile: null,
  tilesLoaded: null,
  groundBuildStart: null,
  groundReady: null,
  ready: null,
  begin: null,
  tileRequests: 0,
  longTasks: { count: 0, totalMs: 0, largest: [] },
};
const longTasks: { start: number; duration: number }[] = [];

export function getStartupReport(): Readonly<StartupReport> {
  return report;
}

function lastMark(name: string): number | null {
  const m = performance.getEntriesByName(name, 'mark');
  return m.length ? m[m.length - 1].startTime : null;
}
function firstMark(name: string): number | null {
  const m = performance.getEntriesByName(name, 'mark');
  return m.length ? m[0].startTime : null;
}

function finishReport(): void {
  report.osmLoaded = firstMark('agents:osm-loaded');
  report.agentsReady = firstMark('agents:ready');
  report.firstTile = firstMark('tiles:first-model');
  report.groundBuildStart = lastMark('ground:build-start');
  report.groundReady = lastMark('ground:ready');
  const tiles = performance
    .getEntriesByType('resource')
    .filter((e) => e.name.includes('/3dtiles/')) as PerformanceResourceTiming[];
  report.tileRequests = tiles.length;
  const before = longTasks.filter((t) => report.ready === null || t.start < report.ready);
  report.longTasks = {
    count: before.length,
    totalMs: Math.round(before.reduce((n, t) => n + t.duration, 0)),
    largest: [...before].sort((a, b) => b.duration - a.duration).slice(0, 3),
  };
  const f = (v: number | null) => (v === null ? '-' : `${(v / 1000).toFixed(2)} s`);
  console.info(
    `[startup] hud ${f(report.hudInit)} | osm ${f(report.osmLoaded)} | agents ${f(report.agentsReady)} | ` +
      `first tile ${f(report.firstTile)} | tiles loaded ${f(report.tilesLoaded)} (${report.tileRequests} requests) | ` +
      `ground grid ${f(report.groundBuildStart)} -> ${f(report.groundReady)} | ` +
      `ready ${f(report.ready)} | long tasks ${report.longTasks.count} = ${report.longTasks.totalMs} ms ` +
      `(largest ${report.longTasks.largest.map((t) => `${Math.round(t.duration)} ms @ ${(t.start / 1000).toFixed(1)} s`).join(', ')})`,
  );
}

type Mode = 'start' | 'vision' | 'hidden';

let overlay: HTMLDivElement | null = null;
let mode: Mode = 'hidden';

export function initStartScreen(hud: HTMLElement): void {
  if (overlay) return;
  report.hudInit = performance.now();
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration });
    });
    obs.observe({ type: 'longtask', buffered: true });
  } catch {
    /* long task timing unsupported */
  }
  initVision(world); // so the picker works before src/senses/ initialises (after the OSM load)
  setGroundLoading(true);

  const el = document.createElement('div');
  overlay = el;
  el.style.cssText =
    'position:fixed;inset:0;z-index:30;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'gap:14px;background:#000;color:#fff;pointer-events:auto;cursor:default;overflow:auto;padding:24px 16px;box-sizing:border-box;' +
    'font:14px/1.45 system-ui,sans-serif;text-align:center;';

  const title = document.createElement('div');
  title.textContent = 'Blind Simulator';
  title.style.cssText = 'font-size:clamp(28px,6vw,48px);font-weight:300;letter-spacing:0.08em;';
  const sub = document.createElement('div');
  sub.style.cssText = 'opacity:0.7;margin-top:-8px;';
  sub.textContent = 'University Road, Warwick. Headphones on.';

  const controls = document.createElement('div');
  controls.style.cssText = 'max-width:640px;opacity:0.85;font-size:13px;';
  controls.textContent =
    'WASD walk (Shift run) · mouse look · speak, clap or SPACE to send sonar · the cane auto-sweeps as you walk ' +
    '(X on/off), hold C or right mouse to sweep by hand, B to tap it · V architect map · O vision · U mute sound';

  const padPanel = createPadPanel();

  const barWrap = document.createElement('div');
  barWrap.style.cssText = 'width:min(320px,80vw);height:2px;background:rgba(255,255,255,0.2);';
  const bar = document.createElement('div');
  bar.style.cssText = 'height:100%;width:0;background:#fff;transition:width 0.2s linear;';
  barWrap.appendChild(bar);
  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;opacity:0.7;min-height:1.4em;';

  const picker = createVisionPicker();
  const route = createRoutePicker();
  const pickers = document.createElement('div');
  pickers.style.cssText = 'display:flex;flex-wrap:wrap;gap:24px;justify-content:center;align-items:flex-start;';
  pickers.append(picker.el, route.el);
  initGoalMessage(hud);

  const begin = document.createElement('button');
  begin.type = 'button';
  begin.style.cssText =
    'font:inherit;font-size:16px;padding:10px 28px;background:#000;color:#fff;border:1px solid #fff;border-radius:4px;';

  el.append(title, sub, controls, padPanel.el, barWrap, status, pickers, begin);
  hud.appendChild(el);
  mode = 'start';

  let readySince = -1;
  let canBegin = false;

  function setBegin(enabled: boolean, text: string): void {
    canBegin = enabled;
    begin.textContent = text;
    begin.disabled = !enabled;
    begin.style.opacity = enabled ? '1' : '0.4';
    begin.style.cursor = enabled ? 'pointer' : 'default';
  }
  setBegin(false, 'Loading…');

  function close(): void {
    el.style.display = 'none';
    mode = 'hidden';
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  function lockPointer(): void {
    const c = getPlayerController();
    if (c && !c.controls.isLocked) {
      try {
        c.controls.lock();
      } catch {
        /* the browser refused: clicking the scene locks it */
      }
    }
  }

  function onBegin(): void {
    if (mode === 'start') {
      if (!canBegin) return;
      startAudio(); // inside the click: browsers only allow audio to start from a gesture
      report.begin = performance.now();
      setGroundLoading(false); // back to the in-game budget
      if (report.ready === null) finishReport(); // "begin anyway" path
      if (!route.hasMap()) route.capture();
      applyRouteStart(); // onto the start point, facing the goal
      route.el.style.display = 'none'; // the route is only chosen before the run
    } else {
      startAudio(); // resume if the browser suspended it
    }
    close();
    lockPointer();
  }
  begin.addEventListener('click', (e) => {
    e.stopPropagation();
    onBegin();
  });
  // a click anywhere on the screen (not on the pickers) also begins / resumes
  el.addEventListener('click', (e) => {
    if (picker.el.contains(e.target as Node) || route.el.contains(e.target as Node)) return;
    onBegin();
  });

  function openVision(): void {
    if (mode !== 'hidden') return;
    mode = 'vision';
    title.textContent = 'Vision';
    sub.textContent = 'Choose how much the player can see. Pings still reveal on top.';
    barWrap.style.display = 'none';
    status.style.display = 'none';
    controls.style.display = 'none';
    el.style.background = 'rgba(0,0,0,0.82)';
    setBegin(true, 'Resume');
    el.style.display = 'flex';
    getPlayerController()?.controls.unlock();
  }

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyO' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t !== picker.el.querySelector('input')) return;
    if (mode === 'hidden') openVision();
    else if (mode === 'vision') onBegin(); // a key press counts as a gesture: re-lock straight away
  });

  // loading progress (polled once per frame; the overlay hides the scene meanwhile)
  world.onUpdate(() => {
    if (mode !== 'hidden') padPanel.update();
    if (mode !== 'start') return;
    const now = performance.now();
    const agentsOk = world.agents.length > 0;
    const tiles = getTileStats();
    const tilesOk = tiles.visible > 0 && tiles.progress >= 1;
    if (tilesOk && report.tilesLoaded === null) report.tilesLoaded = now;
    const ground = groundStatus();
    const p =
      (agentsOk ? W_AGENTS : 0) +
      W_TILES * (tiles.visible > 0 ? Math.min(1, tiles.progress) : 0) +
      W_GROUND * (ground.settled ? 1 : ground.progress * 0.95);
    bar.style.width = `${Math.round(Math.min(1, p) * 100)}%`;

    const allOk = agentsOk && tilesOk && ground.settled;
    if (allOk) {
      if (readySince < 0) readySince = now;
    } else readySince = -1;

    if (allOk && now - readySince >= READY_HOLD_MS) {
      if (report.ready === null) {
        report.ready = now;
        finishReport();
        route.capture(); // the street is loaded: draw it under the route picker
      }
      status.textContent = 'Ready';
      if (!canBegin || begin.textContent !== 'Click to begin') setBegin(true, 'Click to begin');
      return;
    }
    status.textContent = !agentsOk
      ? 'Loading paths and people…'
      : !tilesOk
        ? `Loading the street… ${Math.round(Math.min(1, tiles.progress) * 100)}%`
        : ground.pending
          ? 'Waiting for the street to settle…'
          : `Measuring the ground… ${Math.round(ground.progress * 100)}%`;
    if (now / 1000 > BEGIN_ANYWAY_S) setBegin(true, 'Click to begin (still loading)');
  });
}

/** True while the start screen or the vision overlay is open. */
export function isOverlayOpen(): boolean {
  return mode !== 'hidden';
}

const PAD_NAMES: Record<PadButton, string> = {
  A: 'A',
  B: 'B',
  X: 'X',
  Y: 'Y',
  LB: 'LB',
  RB: 'RB',
  LT: 'LT',
  RT: 'RT',
  VIEW: 'View',
  MENU: 'Menu',
  L3: 'L3',
  R3: 'R3',
  UP: 'D-pad ↑',
  DOWN: 'D-pad ↓',
  LEFT: 'D-pad ←',
  RIGHT: 'D-pad →',
};

/** Controller controls overlay: shown while a controller is connected. */
function createPadPanel(): { el: HTMLElement; update(): void } {
  const el = document.createElement('div');
  el.style.cssText =
    'display:none;max-width:640px;font-size:12px;text-align:left;border:1px solid rgba(255,255,255,0.35);' +
    'border-radius:4px;padding:8px 12px;';
  const head = document.createElement('div');
  head.style.cssText = 'opacity:0.8;margin-bottom:6px;text-align:center;';
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:auto 1fr auto 1fr;gap:2px 10px;';
  const rows: [string, string][] = [
    ...PAD_HELD.map((h): [string, string] => [h.input, h.label]),
    ...PAD_BINDINGS.filter((b) => b.layer === 'base').map((b): [string, string] => [PAD_NAMES[b.button], b.label]),
  ];
  for (const [input, label] of rows) {
    const k = document.createElement('span');
    k.textContent = input;
    k.style.cssText = 'font-weight:600;white-space:nowrap;';
    const v = document.createElement('span');
    v.textContent = label;
    v.style.opacity = '0.85';
    grid.append(k, v);
  }
  const lt = document.createElement('div');
  lt.style.cssText = 'margin-top:6px;opacity:0.7;';
  lt.textContent =
    'Hold LT: ' +
    PAD_BINDINGS.filter((b) => b.layer === 'lt')
      .map((b) => `${PAD_NAMES[b.button]} ${b.label.toLowerCase()}`)
      .join(' · ');
  el.append(head, grid, lt);

  let shownId: string | null = null;
  return {
    el,
    update() {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      let id: string | null = null;
      for (const p of pads) {
        if (p && p.connected) {
          id = p.id;
          break;
        }
      }
      if (id === shownId) return;
      shownId = id;
      el.style.display = id ? 'block' : 'none';
      if (id) head.textContent = `Controller connected: ${id.replace(/\s*\(.*\)\s*$/, '')}`;
    },
  };
}
