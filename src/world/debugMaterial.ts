/**
 * src/world/debugMaterial.ts: TEMPORARY debug material (white world-space grid on black, no sonar mask)
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-foundation
 *
 * Used for tiles and agents while "reveal all" (R) is on, so the world can be checked before the
 * real sonar material (src/render/sonarMaterial.ts, owned by B) is finished. Same grid formula as
 * the README, without the reveal mask. When R is off, everything uses the shared sonarMaterial.
 * Once B's setRevealAll() works, this file can be deleted and getWorldMaterial() can always
 * return sonarMaterial.
 */
import * as THREE from 'three';
import { GRID_SIZE } from '../config';
import { setRevealAll, sonarMaterial } from '../render/sonarMaterial';

export const debugMaterial = new THREE.ShaderMaterial({
  name: 'debugGrid',
  side: THREE.DoubleSide,
  uniforms: {
    uGridSize: { value: GRID_SIZE },
  },
  vertexShader: /* glsl */ `
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uGridSize;
    varying vec3 vWorldPos;
    void main() {
      vec3 p = vWorldPos / uGridSize;
      vec3 g = abs(fract(p - 0.5) - 0.5) / max(fwidth(p), vec3(1e-4));
      float grid = 1.0 - min(min(min(g.x, g.y), g.z), 1.0);
      // fade far away to reduce shimmer (debug only)
      float fade = clamp(1.0 - distance(vWorldPos, cameraPosition) / 600.0, 0.25, 1.0);
      gl_FragColor = vec4(vec3(grid * fade), 1.0);
    }
  `,
});

let revealAll = false;
const listeners = new Set<(on: boolean) => void>();

/** True while "reveal all" (R) is on. */
export function isRevealAll(): boolean {
  return revealAll;
}

/** The material tiles and agents should use right now. */
export function getWorldMaterial(): THREE.Material {
  return revealAll ? debugMaterial : sonarMaterial;
}

/** Turn "reveal all" on/off and tell tiles/agents to swap materials. */
export function setDebugRevealAll(on: boolean): void {
  if (on === revealAll) return;
  revealAll = on;
  setRevealAll(on); // B's material; harmless while it is still a stub
  for (const fn of listeners) fn(on);
}

export function toggleRevealAll(): void {
  setDebugRevealAll(!revealAll);
}

/** Called whenever reveal-all changes. Returns an unsubscribe function. */
export function onRevealAllChange(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Point every mesh under `root` at the current world material (no disposal). */
export function assignWorldMaterial(root: THREE.Object3D): void {
  const material = getWorldMaterial();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) mesh.material = material;
  });
}
