/**
 * src/world/tactile.ts: tactile paving placed from OSM, drawn with the sonar material, world.tactile
 * Owner: TACTILE-WORLD (feat/tactile-world)
 *
 * PLACEMENT (once, as soon as OSM has loaded; every number is in src/world/tactileConfig.ts):
 *   - blister: wherever a footway meets or crosses a road (shared node, segment intersection, or a
 *     footway ending at the road edge) at a real angle, one strip on the kerb on each side of the
 *     road, depth running across the road. Crossings close together are merged.
 *   - guidance: a line of short segments along every footway, plus along each side of a road that
 *     has no parallel footway (offset beyond the estimated road edge). Never on a carriageway, never
 *     on top of a blister strip.
 *   - only strips whose whole footprint is inside the play corridor are kept.
 *
 * GROUND: strips are snapped (height and tilt) to the precomputed ground grid (heightField.ts) and
 * re-snapped whenever that grid is rebuilt. Until the first grid exists they sit at y = 0. After each
 * snap, every strip's height is refined with one downward ray against world.tilesGroup (a couple of
 * ms per frame), because the 2 m grid smooths over kerbs and ramps.
 *
 * RENDERING: two InstancedMeshes (blister: low domes on a thin plate; guidance: ribbed bars on a
 * thin plate), one instance per strip, sharing an object-space sonar material so pings and reveal
 * all (R) show them like everything else. No collision. Hidden while the feature is off.
 *
 * API: fills world.tactile.strips and replaces world.tactile.query(pos, radius) with a spatial-grid
 * lookup (XZ only). query() returns null while the feature is off.
 *
 * TOGGLE: K flips world.setFeature('tactile', ...) mid-run with a short HUD message. The start
 * screen checkbox (src/hud/startScreen.ts) calls setFeature too; both follow 'featureChanged'.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { World } from './index';
import type { FeatureChangedPayload, TactileKind, TactileStrip } from '../shared/contracts';
import { getOsmData, latLonToLocal, type OsmData } from './osm';
import { groundGeneration, isGroundReady, sampleGround } from './heightField';
import { createSonarMaterial } from '../render/sonarMaterial';
import * as C from './tactileConfig';

// --- small 2D helpers (x/z plane) ----------------------------------------------------------------

interface P2 {
  x: number;
  z: number;
}

interface Seg {
  a: P2;
  b: P2;
  /** Unit direction a -> b. */
  dx: number;
  dz: number;
  len: number;
}

interface RoadSeg extends Seg {
  halfWidth: number;
  wayId: number;
}

function makeSeg(a: P2, b: P2): Seg | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) return null;
  return { a, b, dx: dx / len, dz: dz / len, len };
}

/** Closest point parameter (metres from a) of p on segment s, clamped. */
function projectOnSeg(s: Seg, x: number, z: number): number {
  return THREE.MathUtils.clamp((x - s.a.x) * s.dx + (z - s.a.z) * s.dz, 0, s.len);
}

function distToSeg(s: Seg, x: number, z: number): number {
  const t = projectOnSeg(s, x, z);
  return Math.hypot(s.a.x + s.dx * t - x, s.a.z + s.dz * t - z);
}

/** Proper intersection of two segments: parameter (metres) along `s` or null. */
function intersect(s: Seg, r: Seg): number | null {
  const denom = s.dx * r.dz - s.dz * r.dx;
  if (Math.abs(denom) < 1e-6) return null;
  const qx = r.a.x - s.a.x;
  const qz = r.a.z - s.a.z;
  const t = (qx * r.dz - qz * r.dx) / denom; // along s
  const u = (qx * s.dz - qz * s.dx) / denom; // along r
  if (t < 0 || t > s.len || u < 0 || u > r.len) return null;
  return t;
}

/** Angle in degrees between two directions, ignoring their sign (0..90). */
function lineAngleDeg(ax: number, az: number, bx: number, bz: number): number {
  return THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(ax * bx + az * bz))));
}

/** Footprint distance (0 inside) from (x, z) to a strip, using its yaw. */
function footprintDist(s: TactileStrip, x: number, z: number): number {
  const dx = x - s.center.x;
  const dz = z - s.center.z;
  const c = Math.cos(s.yaw);
  const n = Math.sin(s.yaw);
  // local +X = (cos, -sin), local +Z = (sin, cos)
  const lx = dx * c - dz * n;
  const lz = dx * n + dz * c;
  const ex = Math.max(Math.abs(lx) - s.width / 2, 0);
  const ez = Math.max(Math.abs(lz) - s.depth / 2, 0);
  return Math.hypot(ex, ez);
}

/** World x/z of a point given in a strip's local frame. */
function stripPoint(s: TactileStrip, lx: number, lz: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(s.yaw);
  const n = Math.sin(s.yaw);
  return out.set(s.center.x + lx * c + lz * n, 0, s.center.z - lx * n + lz * c);
}

const tmpCorner = new THREE.Vector3();
function insideCorridor(s: TactileStrip, isInside: World['isInsidePlayArea']): boolean {
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    stripPoint(s, (sx * s.width) / 2, (sz * s.depth) / 2, tmpCorner);
    if (!isInside(tmpCorner, C.CORRIDOR_MARGIN)) return false;
  }
  return true;
}

// --- spatial grid --------------------------------------------------------------------------------

class StripGrid {
  private readonly cells = new Map<number, TactileStrip[]>();
  constructor(private readonly cell: number) {}

  private key(ix: number, iz: number): number {
    return (ix + 32768) * 65536 + (iz + 32768);
  }

  clear(): void {
    this.cells.clear();
  }

  add(s: TactileStrip): void {
    const r = Math.hypot(s.width, s.depth) / 2;
    const x0 = Math.floor((s.center.x - r) / this.cell);
    const x1 = Math.floor((s.center.x + r) / this.cell);
    const z0 = Math.floor((s.center.z - r) / this.cell);
    const z1 = Math.floor((s.center.z + r) / this.cell);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = this.key(ix, iz);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(s);
      }
    }
  }

  /** Nearest strip whose footprint is within `radius` of (x, z), optionally of one kind. */
  nearest(x: number, z: number, radius: number, kind?: TactileKind): TactileStrip | null {
    const x0 = Math.floor((x - radius) / this.cell);
    const x1 = Math.floor((x + radius) / this.cell);
    const z0 = Math.floor((z - radius) / this.cell);
    const z1 = Math.floor((z + radius) / this.cell);
    let best: TactileStrip | null = null;
    let bestD = Infinity;
    let bestC = Infinity;
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.cells.get(this.key(ix, iz));
        if (!list) continue;
        for (const s of list) {
          if (kind && s.kind !== kind) continue;
          const d = footprintDist(s, x, z);
          if (d > radius) continue;
          // ties (inside two strips): the one whose centre is closer
          const cd = (s.center.x - x) ** 2 + (s.center.z - z) ** 2;
          if (d < bestD || (d === bestD && cd < bestC)) {
            best = s;
            bestD = d;
            bestC = cd;
          }
        }
      }
    }
    return best;
  }
}

// --- placement -----------------------------------------------------------------------------------

interface Crossing {
  x: number;
  z: number;
  /** Unit road direction at the crossing. */
  dx: number;
  dz: number;
  halfWidth: number;
}

function roadHalfWidth(highway: string): number {
  return C.ROAD_HALF_WIDTH[highway] ?? C.ROAD_HALF_WIDTH_DEFAULT;
}

/**
 * Compute every tactile strip from OSM data (pure: no world state except the corridor test).
 * Exported for testing.
 */
export function placeTactileStrips(data: OsmData, isInside: World['isInsidePlayArea']): TactileStrip[] {
  const pos = new Map<number, P2>();
  for (const n of data.nodes) {
    const v = latLonToLocal(n.lat, n.lon);
    pos.set(n.id, { x: v.x, z: v.z });
  }

  const roads: RoadSeg[] = [];
  /** Road segments touching each road node id. */
  const roadAtNode = new Map<number, RoadSeg[]>();
  /** Segments of footways that get guidance (they count as "this road side has a pavement"). */
  const footSegs: Seg[] = [];
  /** Footway polylines that get guidance. */
  const guidePaths: P2[][] = [];
  /** Footway segments with their end node ids, for crossing detection. */
  const footEdges: { seg: Seg; idA: number; idB: number; endA: boolean; endB: boolean }[] = [];

  for (const way of data.ways) {
    if (way.tags?.area === 'yes') continue;
    const highway = way.tags?.highway ?? '';
    const pts: P2[] = [];
    const ids: number[] = [];
    for (const id of way.nodeIds) {
      const p = pos.get(id);
      if (p) {
        pts.push(p);
        ids.push(id);
      }
    }
    if (pts.length < 2) continue;
    if (way.kind === 'road') {
      const hw = roadHalfWidth(highway);
      for (let k = 1; k < pts.length; k++) {
        const s = makeSeg(pts[k - 1], pts[k]);
        if (!s) continue;
        const r: RoadSeg = { ...s, halfWidth: hw, wayId: way.id };
        roads.push(r);
        for (const id of [ids[k - 1], ids[k]]) {
          let list = roadAtNode.get(id);
          if (!list) roadAtNode.set(id, (list = []));
          list.push(r);
        }
      }
    } else {
      for (let k = 1; k < pts.length; k++) {
        const s = makeSeg(pts[k - 1], pts[k]);
        if (!s) continue;
        if (C.GUIDANCE_HIGHWAYS.includes(highway)) footSegs.push(s);
        footEdges.push({ seg: s, idA: ids[k - 1], idB: ids[k], endA: k === 1, endB: k === pts.length - 1 });
      }
      if (C.GUIDANCE_HIGHWAYS.includes(highway)) guidePaths.push(pts);
    }
  }

  /** Distance from (x, z) to the nearest carriageway edge (< 0 = on a carriageway). */
  const roadEdgeDist = (x: number, z: number): number => {
    let best = Infinity;
    for (const r of roads) best = Math.min(best, distToSeg(r, x, z) - r.halfWidth);
    return best;
  };

  // --- crossings ---
  const crossings: Crossing[] = [];
  const addCrossing = (x: number, z: number, road: RoadSeg, fdx: number, fdz: number): void => {
    if (lineAngleDeg(road.dx, road.dz, fdx, fdz) < C.CROSSING_MIN_ANGLE_DEG) return;
    for (const c of crossings) if (Math.hypot(c.x - x, c.z - z) < C.BLISTER_MERGE_DIST) return;
    crossings.push({ x, z, dx: road.dx, dz: road.dz, halfWidth: road.halfWidth });
  };

  for (const e of footEdges) {
    const f = e.seg;
    // shared node with a road
    for (const [id, p] of [
      [e.idA, f.a],
      [e.idB, f.b],
    ] as const) {
      for (const r of roadAtNode.get(id) ?? []) addCrossing(p.x, p.z, r, f.dx, f.dz);
    }
    for (const r of roads) {
      // crosses the road centre line
      const t = intersect(f, r);
      if (t !== null) {
        addCrossing(f.a.x + f.dx * t, f.a.z + f.dz * t, r, f.dx, f.dz);
        continue;
      }
      // a footway that ends at the road edge (stops at the kerb without reaching the centre line)
      for (const [isEnd, p] of [
        [e.endA, f.a],
        [e.endB, f.b],
      ] as const) {
        if (!isEnd) continue;
        if (distToSeg(r, p.x, p.z) > r.halfWidth + C.ROAD_GUIDANCE_OFFSET) continue;
        const u = projectOnSeg(r, p.x, p.z);
        addCrossing(r.a.x + r.dx * u, r.a.z + r.dz * u, r, f.dx, f.dz);
      }
    }
  }

  const strips: TactileStrip[] = [];
  const blisters: TactileStrip[] = [];
  const blisterGrid = new StripGrid(C.QUERY_CELL);
  let nextId = 0;
  const make = (kind: TactileKind, x: number, z: number, yaw: number, width: number, depth: number): TactileStrip => ({
    id: `${kind}-${nextId++}`,
    kind,
    center: new THREE.Vector3(x, 0, z),
    yaw,
    width,
    depth,
  });

  for (const c of crossings) {
    // across the road: n = (-dz, dx)
    const nx = -c.dz;
    const nz = c.dx;
    for (const side of [-1, 1]) {
      const off = c.halfWidth + C.BLISTER_DEPTH / 2;
      const x = c.x + nx * side * off;
      const z = c.z + nz * side * off;
      // +Z of the strip points at the road (the way you walk to cross)
      const s = make('blister', x, z, Math.atan2(-nx * side, -nz * side), C.BLISTER_WIDTH, C.BLISTER_DEPTH);
      if (!insideCorridor(s, isInside)) continue;
      if (roadEdgeDist(x, z) < C.BLISTER_DEPTH / 2 - 0.05) continue; // landed on another road (junction)
      blisters.push(s);
      blisterGrid.add(s);
    }
  }
  strips.push(...blisters);

  // --- guidance ---
  const guideGrid = new StripGrid(C.QUERY_CELL);
  const guideClear = C.ROAD_CLEARANCE + C.GUIDANCE_WIDTH / 2;
  const tryGuide = (x: number, z: number, dx: number, dz: number): void => {
    if (roadEdgeDist(x, z) < guideClear) return;
    if (blisterGrid.nearest(x, z, C.GUIDANCE_DEPTH / 2)) return;
    // overlapping paths: drop a segment whose centre is right next to an existing one
    const near = guideGrid.nearest(x, z, 0);
    if (near && Math.hypot(near.center.x - x, near.center.z - z) < C.GUIDANCE_MIN_GAP) return;
    const s = make('guidance', x, z, Math.atan2(dx, dz), C.GUIDANCE_WIDTH, C.GUIDANCE_DEPTH);
    if (!insideCorridor(s, isInside)) return;
    guideGrid.add(s);
    strips.push(s);
  };

  /** Walk a polyline, calling fn every GUIDANCE_SPACING metres (continuous across its vertices). */
  const walk = (pts: P2[], fn: (x: number, z: number, dx: number, dz: number) => void): void => {
    let carry = C.GUIDANCE_SPACING / 2;
    for (let k = 1; k < pts.length; k++) {
      const s = makeSeg(pts[k - 1], pts[k]);
      if (!s) continue;
      let t = carry;
      for (; t <= s.len; t += C.GUIDANCE_SPACING) fn(s.a.x + s.dx * t, s.a.z + s.dz * t, s.dx, s.dz);
      carry = t - s.len;
    }
  };

  for (const path of guidePaths) walk(path, tryGuide);

  // roads without a separate footway on a side: guidance just beyond the estimated edge
  const hasFootway = (px: number, pz: number, r: RoadSeg, nx: number, nz: number): boolean => {
    const ex = px + nx * r.halfWidth;
    const ez = pz + nz * r.halfWidth;
    for (const f of footSegs) {
      if (lineAngleDeg(f.dx, f.dz, r.dx, r.dz) > C.ROAD_FOOTWAY_PARALLEL_DEG) continue;
      const t = projectOnSeg(f, ex, ez);
      const cx = f.a.x + f.dx * t;
      const cz = f.a.z + f.dz * t;
      if (Math.hypot(cx - ex, cz - ez) > C.ROAD_FOOTWAY_SEARCH) continue;
      // a cycle lane / path mapped inside the carriageway gets no guidance, so it's no pavement
      if (roadEdgeDist(cx, cz) < guideClear) continue;
      if ((cx - px) * nx + (cz - pz) * nz > 0) return true; // on this side of the road
    }
    return false;
  };
  for (const r of roads) {
    walk([r.a, r.b], (x, z, dx, dz) => {
      for (const side of [-1, 1]) {
        const nx = -dz * side;
        const nz = dx * side;
        if (hasFootway(x, z, r, nx, nz)) continue;
        const off = r.halfWidth + C.ROAD_GUIDANCE_OFFSET;
        tryGuide(x + nx * off, z + nz * off, dx, dz);
      }
    });
  }

  return strips;
}

// --- rendering -----------------------------------------------------------------------------------

function plate(width: number, depth: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(width, C.PLATE_THICKNESS, depth).translate(0, -C.PLATE_THICKNESS / 2, 0);
}

/** Only the position attribute: the sonar shader needs nothing else, and mergeGeometries wants a match. */
function positionsOnly(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  return g;
}

function blisterGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [positionsOnly(plate(C.BLISTER_WIDTH, C.BLISTER_DEPTH))];
  // spherical cap with base radius a and height h
  const a = C.BLISTER_DOME_RADIUS;
  const h = C.BLISTER_DOME_HEIGHT;
  const R = (a * a + h * h) / (2 * h);
  const theta = Math.asin(a / R);
  const dome = positionsOnly(new THREE.SphereGeometry(R, 8, 2, 0, Math.PI * 2, 0, theta).translate(0, h - R, 0));
  // domes centred on grid lines so the sonar lines ride over them
  const p = C.BLISTER_DOME_PITCH;
  const nx = Math.floor((C.BLISTER_WIDTH / 2 - a) / p);
  const nz = Math.floor((C.BLISTER_DEPTH / 2 - a) / p);
  for (let i = -nx; i <= nx; i++) {
    for (let j = -nz; j <= nz; j++) parts.push(dome.clone().translate(i * p, 0, j * p));
  }
  const merged = mergeGeometries(parts)!;
  for (const g of parts) g.dispose();
  dome.dispose();
  return merged;
}

function guidanceGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [positionsOnly(plate(C.GUIDANCE_WIDTH, C.GUIDANCE_DEPTH))];
  const n = C.GUIDANCE_BARS;
  const pitch = C.GUIDANCE_WIDTH / n;
  for (let i = 0; i < n; i++) {
    const x = -C.GUIDANCE_WIDTH / 2 + pitch * (i + 0.5);
    parts.push(
      positionsOnly(
        new THREE.BoxGeometry(C.GUIDANCE_BAR_WIDTH, C.GUIDANCE_BAR_HEIGHT, C.GUIDANCE_DEPTH - pitch / 2).translate(
          x,
          C.GUIDANCE_BAR_HEIGHT / 2,
          0,
        ),
      ),
    );
  }
  const merged = mergeGeometries(parts)!;
  for (const g of parts) g.dispose();
  return merged;
}

const up = new THREE.Vector3();
const ax = new THREE.Vector3();
const az = new THREE.Vector3();
const pa = new THREE.Vector3();
const pb = new THREE.Vector3();

/** Snap a strip to the ground grid: centre height plus a tilt that follows the slope under it. */
function snapMatrix(s: TactileStrip, out: THREE.Matrix4): THREE.Matrix4 {
  const y = sampleGround(s.center.x, s.center.z);
  s.center.y = y;
  const hw = s.width / 2;
  const hd = s.depth / 2;
  stripPoint(s, -hw, 0, pa);
  stripPoint(s, hw, 0, pb);
  ax.subVectors(pb, pa).setY(sampleGround(pb.x, pb.z) - sampleGround(pa.x, pa.z)).normalize();
  stripPoint(s, 0, -hd, pa);
  stripPoint(s, 0, hd, pb);
  az.subVectors(pb, pa).setY(sampleGround(pb.x, pb.z) - sampleGround(pa.x, pa.z)).normalize();
  up.crossVectors(az, ax).normalize();
  ax.crossVectors(up, az).normalize();
  out.makeBasis(ax, up, az);
  out.setPosition(s.center.x, y + C.GROUND_LIFT, s.center.z);
  return out;
}

// --- init ----------------------------------------------------------------------------------------

let initialised = false;

/** Place, draw and expose tactile paving. Safe to call early: waits for OSM and the ground grid itself. */
export function initTactile(world: World): void {
  if (initialised) return;
  initialised = true;

  const group = new THREE.Group();
  group.name = 'tactile';
  group.visible = world.features.tactile;
  world.scene.add(group);

  const grid = new StripGrid(C.QUERY_CELL);
  const strips = world.tactile.strips; // filled in place, so anyone holding the array sees the strips
  world.tactile.query = (pos, radius) =>
    world.features.tactile ? grid.nearest(pos.x, pos.z, Math.max(0, radius)) : null;

  const material = createSonarMaterial({ name: 'tactile', gridSpace: 'object', gridSize: C.TACTILE_GRID_SIZE });
  // flush with the ground: pull the paving slightly towards the camera instead of lifting it
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -2;

  const meshes: { kind: TactileKind; mesh: THREE.InstancedMesh; list: TactileStrip[] }[] = [];
  /** Every instance, for the refinement pass. */
  const instances: { mesh: THREE.InstancedMesh; index: number; strip: TactileStrip; gridY: number }[] = [];
  let snappedGen = -1;
  let refineNext = 0;
  const m = new THREE.Matrix4();

  const snapAll = (): void => {
    instances.length = 0;
    for (const { mesh, list } of meshes) {
      list.forEach((s, i) => {
        mesh.setMatrixAt(i, snapMatrix(s, m));
        instances.push({ mesh, index: i, strip: s, gridY: s.center.y });
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    snappedGen = groundGeneration();
    refineNext = isGroundReady() ? 0 : instances.length; // no point refining y = 0 placeholders
  };

  const ray = new THREE.Raycaster();
  const rayOrigin = new THREE.Vector3();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const hits: THREE.Intersection[] = [];
  /** Refine strip heights against the tiles, a time budget per frame. */
  const refine = (): void => {
    if (refineNext >= instances.length) return;
    const start = performance.now();
    const touched = new Set<THREE.InstancedMesh>();
    do {
      const inst = instances[refineNext++];
      const s = inst.strip;
      rayOrigin.set(s.center.x, inst.gridY + C.REFINE_UP, s.center.z);
      ray.set(rayOrigin, DOWN);
      ray.far = C.REFINE_UP + C.REFINE_DOWN;
      hits.length = 0;
      ray.intersectObject(world.tilesGroup, true, hits);
      let best: number | null = null;
      for (const h of hits) if (best === null || Math.abs(h.point.y - inst.gridY) < Math.abs(best - inst.gridY)) best = h.point.y;
      if (best === null || Math.abs(best - s.center.y) < 1e-3) continue;
      s.center.y = best;
      inst.mesh.getMatrixAt(inst.index, m);
      m.elements[13] = best + C.GROUND_LIFT;
      inst.mesh.setMatrixAt(inst.index, m);
      touched.add(inst.mesh);
    } while (refineNext < instances.length && performance.now() - start < C.REFINE_BUDGET_MS);
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
    if (refineNext >= instances.length) for (const { mesh } of meshes) mesh.computeBoundingSphere();
  };

  const build = (data: OsmData): void => {
    const t0 = performance.now();
    strips.length = 0;
    for (const s of placeTactileStrips(data, world.isInsidePlayArea)) strips.push(s);
    grid.clear();
    for (const s of strips) grid.add(s);

    const geos: Record<TactileKind, THREE.BufferGeometry> = {
      blister: blisterGeometry(),
      guidance: guidanceGeometry(),
    };
    for (const kind of ['blister', 'guidance'] as const) {
      const list = strips.filter((s) => s.kind === kind);
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(geos[kind], material, list.length);
      mesh.name = `tactile-${kind}`;
      mesh.raycast = () => {}; // no collision, no ground hits (the player's rays must not land on it)
      group.add(mesh);
      meshes.push({ kind, mesh, list });
    }
    snapAll();
    const count = (k: TactileKind) => strips.filter((s) => s.kind === k).length;
    console.info(
      `[tactile] ${count('blister')} blister + ${count('guidance')} guidance strips ` +
        `(${(performance.now() - t0).toFixed(0)} ms)`,
    );
  };

  let built = false;
  world.onUpdate(() => {
    if (!built) {
      const data = getOsmData();
      if (!data) return;
      built = true;
      build(data);
      return;
    }
    if (isGroundReady() && groundGeneration() !== snappedGen) snapAll();
    refine();
  });

  world.on('featureChanged', (payload) => {
    const p = payload as FeatureChangedPayload | undefined;
    if (p?.name === 'tactile') group.visible = p.on;
  });

  initToggleKey(world);

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__tactile = { world, strips, group };
  }
}

/** K: toggle tactile paving mid-run, with a short message at the top of the screen. */
function initToggleKey(world: World): void {
  const msg = document.createElement('div');
  msg.style.cssText =
    'position:absolute;left:50%;top:44px;transform:translateX(-50%);padding:4px 10px;z-index:32;' +
    'background:rgba(0,0,0,0.6);border:1px solid #ffd400;color:#ffd400;border-radius:4px;' +
    'white-space:nowrap;display:none;font:14px system-ui,sans-serif;pointer-events:none;';
  (document.getElementById('hud') ?? document.body).appendChild(msg);
  let timer: number | null = null;

  window.addEventListener('keydown', (e) => {
    if (e.code !== C.TOGGLE_KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text'))) return;
    world.setFeature('tactile', !world.features.tactile);
    msg.textContent = `Tactile paving: ${world.features.tactile ? 'ON' : 'OFF'}`;
    msg.style.display = 'block';
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      msg.style.display = 'none';
    }, C.TOGGLE_MESSAGE_MS);
  });
}
