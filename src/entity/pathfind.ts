/**
 * src/entity/pathfind.ts: A* over the OSM PathGraph from src/world/osm.ts
 * Owner: entity (src/entity/)
 *
 * Pure functions (no world/renderer imports) so they can be tested outside the browser.
 * Distances are horizontal (x/z) because node y comes from the ground height.
 */
import type * as THREE from 'three';
import type { PathGraph } from '../world/osm';

type XZ = { x: number; z: number };

export function distXZ(a: XZ, b: XZ): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Index of the graph node closest to `p`, or -1 if the graph is empty. */
export function nearestNode(graph: PathGraph, p: XZ): number {
  let best = -1;
  let bestD = Infinity;
  const { positions } = graph;
  for (let i = 0; i < positions.length; i++) {
    const d = (positions[i].x - p.x) ** 2 + (positions[i].z - p.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Indices of nodes whose distance to `p` is within [min, max]. */
export function nodesInRing(graph: PathGraph, p: XZ, min: number, max: number): number[] {
  const out: number[] = [];
  graph.positions.forEach((pos, i) => {
    const d = distXZ(pos, p);
    if (d >= min && d <= max) out.push(i);
  });
  return out;
}

/**
 * Shortest path of node indices from `start` to `goal` (both included), or null if they
 * are in disconnected parts of the graph.
 */
export function findPath(graph: PathGraph, start: number, goal: number): number[] | null {
  const { positions, neighbours } = graph;
  if (start < 0 || goal < 0 || start >= positions.length || goal >= positions.length) return null;
  if (start === goal) return [start];

  const g = new Map<number, number>([[start, 0]]);
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();
  const heap = new MinHeap();
  heap.push(start, distXZ(positions[start], positions[goal]));

  while (heap.size > 0) {
    const current = heap.pop();
    if (current === goal) return rebuild(cameFrom, goal);
    if (closed.has(current)) continue; // stale heap entry
    closed.add(current);

    const gCur = g.get(current)!;
    for (const next of neighbours[current] ?? []) {
      if (closed.has(next)) continue;
      const tentative = gCur + distXZ(positions[current], positions[next]);
      if (tentative < (g.get(next) ?? Infinity)) {
        g.set(next, tentative);
        cameFrom.set(next, current);
        heap.push(next, tentative + distXZ(positions[next], positions[goal]));
      }
    }
  }
  return null;
}

function rebuild(cameFrom: Map<number, number>, goal: number): number[] {
  const path = [goal];
  let n = goal;
  while (cameFrom.has(n)) {
    n = cameFrom.get(n)!;
    path.push(n);
  }
  return path.reverse();
}

/** Small binary min-heap of (node, priority). */
class MinHeap {
  private nodes: number[] = [];
  private prio: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, priority: number): void {
    this.nodes.push(node);
    this.prio.push(priority);
    let i = this.nodes.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.nodes[0];
    const lastNode = this.nodes.pop()!;
    const lastPrio = this.prio.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode;
      this.prio[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.nodes.length && this.prio[l] < this.prio[m]) m = l;
        if (r < this.nodes.length && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.nodes[a], this.nodes[b]] = [this.nodes[b], this.nodes[a]];
    [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
  }
}

/** Convenience for callers that want vectors rather than indices. */
export function pathPositions(graph: PathGraph, path: number[]): THREE.Vector3[] {
  return path.map((i) => graph.positions[i].clone());
}
