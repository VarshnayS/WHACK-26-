/**
 * src/hud/caneIndicator.ts: small cane gauge at the bottom of the screen while the cane is held
 * Owner: SENSES (HUD)
 *
 * The cane itself is on the ground ~55° below eye level (out of view unless you look down), so this
 * shows where it is in its sweep: a 60° arc with the cane as a line at its current angle. The line
 * thickens briefly on each tap and stays bright while touching something. White only.
 */
import { world } from '../world';
import { getCaneState } from '../senses/cane';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 120;
const H = 70;
/** Pivot (the hand) at the bottom centre; cane drawn this long (px). */
const PX = W / 2;
const PY = H - 6;
const LEN = 56;
/** Seconds a tap keeps the line thick. */
const TAP_FLASH = 0.15;

let root: HTMLDivElement | null = null;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Point at `angle` (+ = left) on a circle of radius r around the pivot. Screen: up = forward. */
function at(angle: number, r: number): [number, number] {
  return [PX - Math.sin(angle) * r, PY - Math.cos(angle) * r];
}

export function initCaneIndicator(hud: HTMLElement): void {
  if (root) return;
  root = document.createElement('div');
  root.style.cssText =
    `position:absolute;left:50%;bottom:14px;transform:translateX(-50%);width:${W}px;height:${H}px;` +
    'pointer-events:none;display:none;';
  const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  const arc = svg('path', { fill: 'none', stroke: 'rgba(255,255,255,0.35)', 'stroke-width': 1, 'stroke-dasharray': '2 3' });
  const cane = svg('line', { x1: PX, y1: PY, stroke: '#fff', 'stroke-linecap': 'round' });
  const tipDot = svg('circle', { r: 2.5, fill: '#fff' });
  s.append(arc, cane, tipDot);
  root.appendChild(s);
  hud.appendChild(root);

  let arcFor = -1;
  world.onUpdate(() => {
    const c = getCaneState();
    if (!root) return;
    root.style.display = c.held ? 'block' : 'none';
    if (!c.held) return;
    if (arcFor !== c.halfArc) {
      arcFor = c.halfArc;
      const [x0, y0] = at(c.halfArc, LEN);
      const [x1, y1] = at(-c.halfArc, LEN);
      arc.setAttribute('d', `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${LEN} ${LEN} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`);
    }
    const [x, y] = at(c.angle, LEN);
    cane.setAttribute('x2', x.toFixed(1));
    cane.setAttribute('y2', y.toFixed(1));
    tipDot.setAttribute('cx', x.toFixed(1));
    tipDot.setAttribute('cy', y.toFixed(1));
    const tapping = performance.now() / 1000 - c.lastTap < TAP_FLASH;
    cane.setAttribute('stroke-width', tapping ? '3' : c.touching ? '2' : '1.2');
    tipDot.setAttribute('r', tapping ? '4' : '2.5');
  });
}
