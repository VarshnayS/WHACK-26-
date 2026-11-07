/**
 * src/world/agentMaterial.ts: the sonar material for agents (object-space grid, instancing-ready)
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-polish
 *
 * Agents are drawn like everything else: black surfaces, white grid lines, revealed only by sonar.
 * They share the sonar uniforms (src/render/sonarMaterial.ts: sonarUniforms, MAX_PINGS), so whatever
 * drives those (pings, player position, time) reveals agents too. The two differences from the tile
 * material are needed for moving, articulated bodies:
 *
 *   - the grid is in OBJECT space (per body part / per car), so the lines travel with the limbs
 *     instead of sliding over them as the body moves (tiles never move, so they use world space);
 *   - the vertex shader understands InstancedMesh (one draw call per body part for all pedestrians).
 *
 * The reveal mask is the one in the README ("How the sonar material works"), still in world space.
 * Until the sonar pipeline runs (uTime stays 0 in the placeholder), agents stay pitch black, matching
 * the placeholder sonarMaterial. R (reveal all) draws the full grid on every agent, like debugMaterial.
 *
 * TODO(B): when the real sonar shader lands, fold this variant into src/render/sonarMaterial.ts
 * (a `vGridPos` varying + instancing in the vertex shader) so there is one shader source again.
 */
import * as THREE from 'three';
import { GRID_SIZE } from '../config';
import { MAX_PINGS, sonarUniforms } from '../render/sonarMaterial';
import { isRevealAll, onRevealAllChange } from './debugMaterial';

const vertexShader = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vGridPos;
  void main() {
    mat4 model = modelMatrix;
    #ifdef USE_INSTANCING
      model = modelMatrix * instanceMatrix;
    #endif
    vec4 wp = model * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    // object-space position, scaled by the part's own scale so grid spacing is the same in metres everywhere
    vec3 s = vec3(length(model[0].xyz), length(model[1].xyz), length(model[2].xyz));
    vGridPos = position * s;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uGridSize;
  uniform float uArmReach;
  uniform float uWaveSpeed;
  uniform vec3 uPlayerPos;
  uniform vec3 uPingOrigin[MAX_PINGS];
  uniform float uPingStart[MAX_PINGS];
  uniform float uPingRange[MAX_PINGS];
  uniform float uRevealAll;
  uniform float uDebugAll;
  varying vec3 vWorldPos;
  varying vec3 vGridPos;

  void main() {
    vec3 p = vGridPos / uGridSize;
    vec3 fw = max(fwidth(p), vec3(1e-4));
    vec3 g = abs(fract(p - 0.5) - 0.5) / fw;
    float grid = 1.0 - min(min(min(g.x, g.y), g.z), 1.0);
    // lines closer together than a few pixels turn into a white smear: fade them out with distance
    grid *= 1.0 - smoothstep(0.3, 0.7, max(max(fw.x, fw.y), fw.z));

    float reveal = 1.0 - smoothstep(uArmReach * 0.8, uArmReach, distance(vWorldPos, uPlayerPos));
    for (int i = 0; i < MAX_PINGS; i++) {
      float d = distance(vWorldPos, uPingOrigin[i]);
      float age = uTime - uPingStart[i];
      float r = age * uWaveSpeed;
      float ring = 1.0 - smoothstep(0.0, 0.6, abs(d - r));
      float trail = step(d, r) * exp(-age * 1.5);
      reveal = max(reveal, max(ring, trail * 0.4) * step(d, uPingRange[i]));
    }
    // sonar not running yet (uTime never advances in the placeholder) -> stay black
    reveal *= step(0.0001, uTime);

    if (uRevealAll > 0.5 || uDebugAll > 0.5) reveal = 1.0;
    gl_FragColor = vec4(vec3(grid * reveal), 1.0);
  }
`;

/** 1 while "reveal all" (R) is on. Shared by every agent material. */
const debugAll: THREE.IUniform<number> = { value: isRevealAll() ? 1 : 0 };
onRevealAllChange((on) => {
  debugAll.value = on ? 1 : 0;
});

/**
 * A sonar material for agents. `gridSize` is the line spacing in metres on the object (people get a
 * finer grid than tiles so a 0.2 m head still shows lines; cars use the world grid size).
 */
export function createAgentMaterial(name: string, gridSize: number = GRID_SIZE): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name,
    uniforms: { ...sonarUniforms, uGridSize: { value: gridSize }, uDebugAll: debugAll },
    defines: { MAX_PINGS },
    vertexShader,
    fragmentShader,
  });
}

/** Grid spacing on people (m): fine enough to read on a hand-sized limb. */
export const PERSON_GRID_SIZE = 0.1;
/** Grid spacing on cars (m). */
export const CAR_GRID_SIZE = 0.25;
