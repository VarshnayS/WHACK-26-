/**
 * src/render/sonarMaterial.ts: THE shared material (world-space grid lines x sonar reveal mask)
 * Owner: @USERNAME_B (sonar material)
 * Branch: feat/sonar-material
 *
 * STUB: uniforms and exports are final; the shaders are placeholders that draw pure black.
 * See README "How the sonar material works" for the intended fragment shader.
 * Tiles and agents all use `sonarMaterial`; never add per-object materials.
 */
import * as THREE from 'three';
import { ARM_REACH, GRID_SIZE, WAVE_SPEED } from '../config';

/** Maximum simultaneous pings (array size in the shader). */
export const MAX_PINGS = 8;

/** A ping start time this far in the past means "slot unused". */
export const PING_UNUSED = -1e6;

export type SonarUniforms = {
  uTime: THREE.IUniform<number>;
  uGridSize: THREE.IUniform<number>;
  uArmReach: THREE.IUniform<number>;
  uWaveSpeed: THREE.IUniform<number>;
  uPlayerPos: THREE.IUniform<THREE.Vector3>;
  uPingOrigin: THREE.IUniform<THREE.Vector3[]>;
  uPingStart: THREE.IUniform<number[]>;
  uPingRange: THREE.IUniform<number[]>;
  /** 1 = debug "reveal everything" (R key): full grid, no sonar mask. */
  uRevealAll: THREE.IUniform<number>;
};

export const sonarUniforms: SonarUniforms = {
  uTime: { value: 0 },
  uGridSize: { value: GRID_SIZE },
  uArmReach: { value: ARM_REACH },
  uWaveSpeed: { value: WAVE_SPEED },
  uPlayerPos: { value: new THREE.Vector3() },
  uPingOrigin: { value: Array.from({ length: MAX_PINGS }, () => new THREE.Vector3()) },
  uPingStart: { value: new Array<number>(MAX_PINGS).fill(PING_UNUSED) },
  uPingRange: { value: new Array<number>(MAX_PINGS).fill(0) },
  uRevealAll: { value: 0 },
};

// TODO(B): real grid x reveal shader. Placeholder: passes world position through, draws black.
const vertexShader = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  }
`;

/** The one material every tile and agent uses. */
export const sonarMaterial = new THREE.ShaderMaterial({
  uniforms: sonarUniforms,
  vertexShader,
  fragmentShader,
});

/** Debug: show the full grid everywhere (R key), for checking alignment. */
export function setRevealAll(on: boolean): void {
  void on; // placeholder
}
