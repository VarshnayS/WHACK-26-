/**
 * src/hud/routePicker.ts: pick the start and goal points on a top-down map (start screen)
 * Owner: SENSES (HUD)
 *
 * The map is the audit report's top-down snapshot (src/world/audit/topDownMap.ts), rendered once
 * when the world has loaded, shaded by height (street dark, buildings bright). Until then the corridor outline is drawn on
 * black and points can already be placed. Click to place the selected point (START or GOAL);
 * placing the start switches to the goal. Right-click always places the goal. White on black only.
 *
 * The route itself (state, storage, spawning, arrival) lives in src/player/route.ts.
 * initGoalMessage() shows "Goal reached" in game.
 */
import { world } from '../world';
import { corridorCorners } from '../world/playArea';
import { captureTopDownMap, mapToWorld, topDownView, worldToMap, type TopDownView } from '../world/audit/topDownMap';
import { getRoute, onGoalReached, onRouteChange, resetRoute, setRouteGoal, setRouteStart, type RoutePoint } from '../player/route';

/** Map image size in pixels (backing store; CSS scales it). 2.25:1 fits the 216 × 96 m padded corridor. */
const MAP_W = 900;
const MAP_H = 400;
/** Metres of padding around the corridor in the map. */
const MAP_PADDING_M = 8;

const BTN =
  'font:inherit;font-size:12px;cursor:pointer;padding:5px 10px;border:1px solid rgba(255,255,255,0.45);border-radius:4px;';

type Placing = 'start' | 'goal';

export interface RoutePicker {
  el: HTMLElement;
  /** Render the top-down map now (call once the world has loaded). Returns false if it failed. */
  capture(): boolean;
  /** True once a map image has been captured. */
  hasMap(): boolean;
  dispose(): void;
}

export function createRoutePicker(): RoutePicker {
  const el = document.createElement('div');
  el.style.cssText = 'width:min(560px,90vw);text-align:left;pointer-events:auto;';

  const heading = document.createElement('div');
  heading.textContent = 'Route';
  heading.style.cssText = 'font-size:13px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.7;margin:0 0 8px;';

  const canvas = document.createElement('canvas');
  canvas.width = MAP_W;
  canvas.height = MAP_H;
  canvas.style.cssText =
    `display:block;width:100%;aspect-ratio:${MAP_W}/${MAP_H};cursor:crosshair;` +
    'border:1px solid rgba(255,255,255,0.45);border-radius:4px;background:#000;';
  canvas.setAttribute('aria-label', 'Top-down map of the street: click to place the start and goal');
  const ctx = canvas.getContext('2d');

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px;';
  const startBtn = document.createElement('button');
  const goalBtn = document.createElement('button');
  const clearGoalBtn = document.createElement('button');
  const resetBtn = document.createElement('button');
  const refreshBtn = document.createElement('button');
  startBtn.textContent = 'Place start';
  goalBtn.textContent = 'Place goal';
  clearGoalBtn.textContent = 'No goal';
  resetBtn.textContent = 'Reset';
  refreshBtn.textContent = 'Refresh map';
  for (const b of [startBtn, goalBtn, clearGoalBtn, resetBtn, refreshBtn]) b.type = 'button';
  row.append(startBtn, goalBtn, clearGoalBtn, resetBtn, refreshBtn);

  const info = document.createElement('div');
  info.style.cssText = 'font-size:11px;opacity:0.75;margin-top:6px;min-height:1.4em;';

  el.append(heading, canvas, row, info);

  const view: TopDownView = topDownView(MAP_W / MAP_H, MAP_PADDING_M);
  let mapImage: HTMLCanvasElement | null = null;
  let placing: Placing = 'start';

  function setPlacing(p: Placing): void {
    placing = p;
    startBtn.style.cssText = BTN + (p === 'start' ? 'background:#fff;color:#000;' : 'background:#000;color:#fff;');
    goalBtn.style.cssText = BTN + (p === 'goal' ? 'background:#fff;color:#000;' : 'background:#000;color:#fff;');
    draw();
  }
  for (const b of [clearGoalBtn, resetBtn, refreshBtn]) b.style.cssText = BTN + 'background:#000;color:#fff;';

  function toPx(p: RoutePoint): { x: number; y: number } {
    const { u, v } = worldToMap(view, p.x, p.z);
    return { x: u * MAP_W, y: v * MAP_H };
  }

  function label(text: string, x: number, y: number): void {
    if (!ctx) return;
    ctx.font = 'bold 15px system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x, y);
  }

  function draw(): void {
    if (!ctx) return;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, MAP_W, MAP_H);
    if (mapImage) ctx.drawImage(mapImage, 0, 0, MAP_W, MAP_H);

    // corridor walls
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    corridorCorners().forEach((c, i) => {
      const p = toPx({ x: c.x, z: c.z });
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.stroke();

    if (!mapImage) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '14px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('The street appears here once it has loaded', MAP_W / 2, MAP_H / 2);
    }

    const { start, goal } = getRoute();
    const s = toPx(start);
    if (goal) {
      const g = toPx(goal);
      // dashed line with a black halo so it shows over bright buildings too
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(g.x, g.y);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      // goal: ring + dot, black halo
      ctx.beginPath();
      ctx.arc(g.x, g.y, 11, 0, Math.PI * 2);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(g.x, g.y, 4, 0, Math.PI * 2);
      ctx.fill();
      label('GOAL', g.x, g.y - 15);
    }
    // start: solid dot with a black rim
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fill();
    label('START', s.x, s.y - 13);
    ctx.restore();

    const dist = goal ? Math.hypot(goal.x - start.x, goal.z - start.z) : 0;
    info.textContent =
      (placing === 'start' ? 'Click the map to place the START.' : 'Click the map to place the GOAL.') +
      ' Right-click places the goal. ' +
      (goal ? `Goal ${Math.round(dist)} m away in a straight line.` : 'No goal: free roaming.');
  }

  function onClick(e: MouseEvent, forceGoal: boolean): void {
    e.preventDefault();
    e.stopPropagation();
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const p = mapToWorld(view, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    if (forceGoal || placing === 'goal') {
      setRouteGoal(p);
    } else {
      setRouteStart(p);
      setPlacing('goal');
    }
  }
  canvas.addEventListener('click', (e) => onClick(e, false));
  canvas.addEventListener('contextmenu', (e) => onClick(e, true));
  startBtn.addEventListener('click', () => setPlacing('start'));
  goalBtn.addEventListener('click', () => setPlacing('goal'));
  clearGoalBtn.addEventListener('click', () => setRouteGoal(null));
  resetBtn.addEventListener('click', () => {
    resetRoute();
    setPlacing('start');
  });
  refreshBtn.addEventListener('click', () => {
    capture();
  });

  const offChange = onRouteChange(() => draw());

  function capture(): boolean {
    const map = captureTopDownMap(world, {
      width: MAP_W,
      height: MAP_H,
      paddingM: MAP_PADDING_M,
      heightShade: true,
      into: mapImage ?? undefined,
    });
    if (map) mapImage = map.image;
    draw();
    return map !== null;
  }

  setPlacing('start');

  return {
    el,
    capture,
    hasMap: () => mapImage !== null,
    dispose() {
      offChange();
      el.remove();
    },
  };
}

/** In game: a short "Goal reached" banner when the player arrives (src/player/route.ts). */
export function initGoalMessage(hud: HTMLElement): void {
  const el = document.createElement('div');
  el.style.cssText =
    'position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);padding:14px 26px;display:none;' +
    'background:rgba(0,0,0,0.85);border:1px solid #fff;border-radius:6px;color:#fff;text-align:center;' +
    'font:20px/1.4 system-ui,sans-serif;letter-spacing:0.04em;pointer-events:none;z-index:20;';
  hud.appendChild(el);
  let timer = 0;
  onGoalReached(({ seconds }) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    el.textContent = `Goal reached in ${m}:${String(s).padStart(2, '0')}`;
    el.style.display = 'block';
    window.clearTimeout(timer);
    timer = window.setTimeout(() => (el.style.display = 'none'), 6000);
  });
}
