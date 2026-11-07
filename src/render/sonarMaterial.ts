/**
 * src/render/sonarMaterial.ts: THE shared material (grid lines x sonar reveal mask)
 * Owner: RENDER (feat/sonar-render)
 *
 * Every tile, agent and the entity is drawn with this shader. Surfaces are black; the only thing
 * ever drawn is white grid lines, and only where something reveals them:
 *
 *   - arm's reach: always on, within uArmReach of the player's body (a segment from eye to feet);
 *   - pings: each active ping (src/render/pings.ts fills the uniforms from world.activePings())
 *     draws an expanding ring with a fading trail behind it, clipped to its range. The ring's look
 *     comes from the ping's style (speed, thickness, brightness, fade);
 *   - reveal all (R, setRevealAll): the full grid everywhere, no mask.
 *
 * Grid: lines are drawn only along the axes tangent to the surface (an axis whose grid planes are
 * parallel to the face is dropped, so a flat face lying on a grid plane is not solid white), and each
 * axis fades out as its lines get closer than a few pixels (removes distant moire). A coarse grid
 * (GRID_COARSE x spacing) takes over where the fine one has faded, so distant surfaces still read.
 *
 * Tiles use the world-space grid (`sonarMaterial`). Moving or articulated objects (agents, entity)
 * should use createSonarMaterial({ gridSpace: 'object' }): the grid is fixed to the object, so lines
 * travel with it instead of sliding over it. InstancedMesh is supported in both modes.
 *
 * White on black only: never output colour.
 */
import * as THREE from 'three';
import { MAX_PINGS } from '../shared/contracts';
import { ARM_REACH, EYE_HEIGHT, GRID_SIZE, WAVE_SPEED } from '../config';

export { MAX_PINGS };

/** A ping start time this far in the past means "slot unused" (legacy uPingStart only). */
export const PING_UNUSED = -1e6;

/** Coarse grid spacing as a multiple of the grid size (shown where the fine grid fades out). */
const GRID_COARSE = 4;
/** Brightness of the coarse grid relative to the fine grid. */
const GRID_COARSE_LEVEL = 0.6;
/** Trail brightness relative to the ring, right behind it (then decays with the ping's fade). */
const TRAIL_LEVEL = 0.35;
/** Arm's reach glow fades in from this fraction of uArmReach. */
const ARM_REACH_SOFT = 0.5;

export type SonarUniforms = {
  /** Shader clock in seconds (performance.now() / 1000). */
  uTime: THREE.IUniform<number>;
  uGridSize: THREE.IUniform<number>;
  uArmReach: THREE.IUniform<number>;
  /** Height of the player's body below uPlayerPos (eye to feet), for the arm's reach glow. */
  uPlayerHeight: THREE.IUniform<number>;
  uPlayerPos: THREE.IUniform<THREE.Vector3>;
  /** Number of used slots in uPingA / uPingB. */
  uPingCount: THREE.IUniform<number>;
  /** Per ping: xyz = origin, w = current ring radius (m). */
  uPingA: THREE.IUniform<THREE.Vector4[]>;
  /** Per ping: x = range (m), y = ring thickness (m), z = brightness 0..1, w = trail fade per metre. */
  uPingB: THREE.IUniform<THREE.Vector4[]>;
  /** 1 = debug "reveal everything" (R key): full grid, no sonar mask. */
  uRevealAll: THREE.IUniform<number>;
  /**
   * @deprecated Legacy ping layout, still read by src/world/agentMaterial.ts until it switches to
   * createSonarMaterial({ gridSpace: 'object' }). Filled so its rings line up with the real ones.
   */
  uWaveSpeed: THREE.IUniform<number>;
  /** @deprecated see uWaveSpeed */
  uPingOrigin: THREE.IUniform<THREE.Vector3[]>;
  /** @deprecated see uWaveSpeed */
  uPingStart: THREE.IUniform<number[]>;
  /** @deprecated see uWaveSpeed */
  uPingRange: THREE.IUniform<number[]>;
};

export const sonarUniforms: SonarUniforms = {
  uTime: { value: 0 },
  uGridSize: { value: GRID_SIZE },
  uArmReach: { value: ARM_REACH },
  uPlayerHeight: { value: EYE_HEIGHT },
  uPlayerPos: { value: new THREE.Vector3() },
  uPingCount: { value: 0 },
  uPingA: { value: Array.from({ length: MAX_PINGS }, () => new THREE.Vector4()) },
  uPingB: { value: Array.from({ length: MAX_PINGS }, () => new THREE.Vector4()) },
  uRevealAll: { value: 0 },
  uWaveSpeed: { value: WAVE_SPEED },
  uPingOrigin: { value: Array.from({ length: MAX_PINGS }, () => new THREE.Vector3()) },
  uPingStart: { value: new Array<number>(MAX_PINGS).fill(PING_UNUSED) },
  uPingRange: { value: new Array<number>(MAX_PINGS).fill(0) },
};

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
    #ifdef OBJECT_GRID
      // object space, scaled by the object's own scale so the spacing is in metres everywhere
      vec3 s = vec3(length(model[0].xyz), length(model[1].xyz), length(model[2].xyz));
      vGridPos = position * s;
    #else
      vGridPos = wp.xyz;
    #endif
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uGridSize;
  uniform float uArmReach;
  uniform float uPlayerHeight;
  uniform vec3 uPlayerPos;
  uniform int uPingCount;
  uniform vec4 uPingA[MAX_PINGS];
  uniform vec4 uPingB[MAX_PINGS];
  uniform float uRevealAll;
  varying vec3 vWorldPos;
  varying vec3 vGridPos;

  // Anti-aliased grid lines for p in grid cells; n = unit surface normal in the same space.
  float sonarGrid(vec3 p, vec3 n) {
    vec3 fw = max(fwidth(p), vec3(1e-5));
    // distance to the nearest line of each axis, in pixels -> ~2 px wide lines
    vec3 line = 1.0 - min(abs(fract(p - 0.5) - 0.5) / fw, 1.0);
    // drop the axis the surface faces: its grid planes are parallel to the face
    vec3 tangent = 1.0 - smoothstep(0.85, 0.97, abs(n));
    // fade an axis out once its lines are closer than ~3 px (moire)
    vec3 density = 1.0 - smoothstep(0.2, 0.45, fw);
    vec3 l = line * tangent * density;
    return max(max(l.x, l.y), l.z);
  }

  void main() {
    // flat face normal from screen-space derivatives (no normal attribute needed)
    vec3 n = normalize(cross(dFdx(vGridPos), dFdy(vGridPos)));
    vec3 gp = vGridPos / uGridSize;
    float grid = max(sonarGrid(gp, n), sonarGrid(gp * (1.0 / GRID_COARSE), n) * GRID_COARSE_LEVEL);

    float reveal = uRevealAll;

    // arm's reach: distance to the player's body, a vertical segment from the eye down to the feet
    vec3 toEye = vWorldPos - uPlayerPos;
    float below = clamp(-toEye.y, 0.0, uPlayerHeight);
    float dBody = length(toEye + vec3(0.0, below, 0.0));
    reveal = max(reveal, 1.0 - smoothstep(uArmReach * ARM_REACH_SOFT, uArmReach, dBody));

    for (int i = 0; i < MAX_PINGS; i++) {
      if (i >= uPingCount || reveal >= 1.0) break;
      vec4 a = uPingA[i]; // origin, radius
      vec4 b = uPingB[i]; // range, thickness, brightness, fade per metre
      float d = distance(vWorldPos, a.xyz);
      if (d > b.x) continue;
      float x = d - a.w; // > 0: the wave hasn't got here yet
      // crisp leading edge, softer back edge
      float ring = 1.0 - smoothstep(0.0, x > 0.0 ? b.y * 0.2 : b.y, abs(x));
      float trail = x < 0.0 ? TRAIL_LEVEL * exp(x * b.w) : 0.0;
      float edge = 1.0 - smoothstep(b.x * 0.8, b.x, d); // soft clip at the range
      float falloff = 1.0 - 0.5 * d / b.x;               // the wave weakens as it spreads
      reveal = max(reveal, max(ring, trail) * b.z * edge * falloff);
    }

    gl_FragColor = vec4(vec3(grid * min(reveal, 1.0)), 1.0);
  }
`;

export interface SonarMaterialOptions {
  /** Debug name. */
  name?: string;
  /**
   * 'world' (default): grid fixed in world space, for static geometry (tiles).
   * 'object': grid fixed to the object (scaled to metres), for anything that moves or bends, so
   * lines don't slide over it. Works with InstancedMesh (grid per instance).
   */
  gridSpace?: 'world' | 'object';
  /** Grid line spacing in metres (default GRID_SIZE). */
  gridSize?: number;
}

/**
 * A sonar material variant. All variants share the sonar uniforms (time, player, pings, reveal all),
 * so every ping reveals every object; only the grid space and spacing differ. Create one per
 * spacing/space combination and share it, not one per object.
 */
export function createSonarMaterial(options: SonarMaterialOptions = {}): THREE.ShaderMaterial {
  const { name = 'sonar', gridSpace = 'world', gridSize } = options;
  const uniforms =
    gridSize === undefined ? sonarUniforms : { ...sonarUniforms, uGridSize: { value: gridSize } };
  const defines: Record<string, number | string> = {
    MAX_PINGS,
    GRID_COARSE: GRID_COARSE.toFixed(1),
    GRID_COARSE_LEVEL: GRID_COARSE_LEVEL.toFixed(2),
    TRAIL_LEVEL: TRAIL_LEVEL.toFixed(2),
    ARM_REACH_SOFT: ARM_REACH_SOFT.toFixed(2),
  };
  if (gridSpace === 'object') defines.OBJECT_GRID = 1;
  return new THREE.ShaderMaterial({
    name,
    uniforms,
    defines,
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide, // photogrammetry has stray back faces; the grid looks the same either side
  });
}

/** The one material every tile uses (world-space grid). */
export const sonarMaterial = createSonarMaterial({ name: 'sonar' });

/** Debug: show the full grid everywhere (R key), for checking alignment. */
export function setRevealAll(on: boolean): void {
  sonarUniforms.uRevealAll.value = on ? 1 : 0;
}

/** True while reveal-all is on. */
export function isRevealAll(): boolean {
  return sonarUniforms.uRevealAll.value > 0.5;
}
