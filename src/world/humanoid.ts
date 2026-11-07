/**
 * src/world/humanoid.ts: procedural low-poly people, one InstancedMesh per body part
 * Owner: @USERNAME_A (world/tiles/agents)
 * Branch: feat/world-polish
 *
 * A HumanoidCrowd draws every pedestrian with 7 draw calls in total: head, torso, upper/lower arm,
 * upper/lower leg and foot. Each part is one InstancedMesh with a unit-sized geometry (arms, legs and
 * feet have their pivot at the joint) and a per-instance scale for height and build. Left and right
 * limbs are separate instances of the same mesh (index = person * 2 + side).
 *
 * The pose is procedural, no animation data: a sine-wave walk cycle (legs and arms swing in
 * antiphase, knees bend during the swing, the pelvis rides on whichever leg is lower so the feet
 * stay on the ground and the body bobs naturally), a standing pose with a little idle sway, and a
 * stumble pose (leaning, arms flung out, knees buckled). The three are blended by `speed` and
 * `stumble`. Pelvis height comes from forward kinematics of both legs, so any pose stays grounded.
 *
 * Coordinates: model faces +Z, +X is the person's left, feet at y = 0.
 */
import * as THREE from 'three';

export interface PersonShape {
  /** Standing height in metres (1.6 to 1.9). */
  height: number;
  /** Width scale of torso and limbs (about 0.85 to 1.2). */
  build: number;
}

export interface PoseInput {
  /** Position of the feet on the ground. */
  x: number;
  y: number;
  z: number;
  /** Heading: rotation about +Y (0 faces +Z). */
  yaw: number;
  /** Gait phase in radians; advance it with strideLength() as the person walks. */
  phase: number;
  /** Current walking speed in m/s (0 = standing). */
  speed: number;
  /** 0 = normal, 1 = full stumble. */
  stumble: number;
  /** Seconds since the stumble began (drives the arm flail). */
  stumbleTime: number;
  /** Stumble lean in radians: pitch + = forward, roll + = towards the person's left (+X). */
  leanPitch: number;
  leanRoll: number;
  /** Clock in seconds and a per-person number, for the idle sway. */
  time: number;
  seed: number;
}

/** Distance covered by one full gait cycle (two steps) for a person of this height, in metres. */
export function strideLength(height: number): number {
  return 1.5 * (height / 1.75);
}

// --- proportions (fractions of standing height) ------------------------------------------------
const LEG_UPPER = 0.255;
const LEG_LOWER = 0.235;
const FOOT_H = 0.04;
const TORSO_LEN = 0.31;
const HEAD_D = 0.13;
const ARM_UPPER = 0.17;
const ARM_LOWER = 0.16;

// --- gait --------------------------------------------------------------------------------------
const LEG_AMP = 0.52; // rad thigh swing at 1.4 m/s
const KNEE_AMP = 0.95; // rad extra knee bend during the swing
const ARM_AMP = 0.45;
const REFERENCE_SPEED = 1.4;

interface Dims {
  height: number;
  torsoW: number;
  torsoD: number;
  torsoLen: number;
  headD: number;
  hipX: number;
  shoulderX: number;
  shoulderY: number;
  armU: number;
  armL: number;
  armUD: number;
  armLD: number;
  legU: number;
  legL: number;
  legUD: number;
  legLD: number;
  footW: number;
  footH: number;
  footL: number;
}

function emptyDims(): Dims {
  return {
    height: 1.75, torsoW: 0, torsoD: 0, torsoLen: 0, headD: 0, hipX: 0, shoulderX: 0, shoulderY: 0, armU: 0, armL: 0,
    armUD: 0, armLD: 0, legU: 0, legL: 0, legUD: 0, legLD: 0, footW: 0, footH: 0, footL: 0,
  };
}

function fillDims(d: Dims, shape: PersonShape): void {
  const H = shape.height;
  const b = shape.build;
  d.height = H;
  d.torsoW = 0.235 * H * b;
  d.torsoD = 0.13 * H * b;
  d.torsoLen = TORSO_LEN * H;
  d.headD = HEAD_D * H;
  d.hipX = 0.05 * H * b;
  d.armUD = 0.065 * H * b;
  d.armLD = 0.055 * H * b;
  d.shoulderX = d.torsoW / 2 + d.armUD * 0.35;
  d.shoulderY = d.torsoLen - 0.025 * H;
  d.armU = ARM_UPPER * H;
  d.armL = ARM_LOWER * H;
  d.legU = LEG_UPPER * H;
  d.legL = LEG_LOWER * H;
  d.legUD = 0.095 * H * b;
  d.legLD = 0.075 * H * b;
  d.footW = 0.055 * H * b;
  d.footH = FOOT_H * H;
  d.footL = 0.145 * H;
}

// --- geometry ----------------------------------------------------------------------------------

/** Unit-sized tapered cylinder hanging down from its pivot at the origin (y from 0 to -1). */
function hangingLimb(topRadius: number, bottomRadius: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(topRadius, bottomRadius, 1, 6);
  g.translate(0, -0.5, 0);
  return g;
}

function createGeometries() {
  const head = new THREE.SphereGeometry(0.5, 8, 6);
  const torso = new THREE.CylinderGeometry(0.5, 0.38, 1, 8); // shoulders wider than hips
  torso.translate(0, 0.5, 0); // pivot at the hips
  const foot = new THREE.BoxGeometry(1, 1, 1);
  foot.translate(0, -0.5, 0.25); // pivot at the ankle; the toes point +Z
  return {
    head,
    torso,
    upperArm: hangingLimb(0.5, 0.42),
    lowerArm: hangingLimb(0.42, 0.3),
    upperLeg: hangingLimb(0.5, 0.4),
    lowerLeg: hangingLimb(0.4, 0.28),
    foot,
  };
}

// --- scratch objects (no allocation per frame) -------------------------------------------------
const euler = new THREE.Euler();
const quat = new THREE.Quaternion();
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);
const root = new THREE.Matrix4();
const local = new THREE.Matrix4();
const torsoM = new THREE.Matrix4();
const shoulderM = new THREE.Matrix4();
const upperM = new THREE.Matrix4();
const lowerM = new THREE.Matrix4();
const partM = new THREE.Matrix4();
const instM = new THREE.Matrix4();

/** local = translate(tx, ty, tz) * rotate(rx, ry, rz) (YXZ order). */
function trs(out: THREE.Matrix4, tx: number, ty: number, tz: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  euler.set(rx, ry, rz, 'YXZ');
  quat.setFromEuler(euler);
  return out.compose(pos.set(tx, ty, tz), quat, ONE);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Sets instance `index` of `mesh` to `world` scaled by (sx, sy, sz) (scale applies to the part only). */
function put(mesh: THREE.InstancedMesh, index: number, world: THREE.Matrix4, sx: number, sy: number, sz: number): void {
  instM.copy(world).scale(scl.set(sx, sy, sz));
  mesh.setMatrixAt(index, instM);
}

// stumble pose targets, per side (index 0 = left, 1 = right)
const STUMBLE_THIGH = [0.55, -0.4];
const STUMBLE_KNEE = [0.25, 0.9];

export class HumanoidCrowd {
  /** Add this to the scene (or world.agentsGroup). */
  readonly group = new THREE.Group();
  readonly meshes: THREE.InstancedMesh[];

  private readonly dims: Dims[];
  private readonly head: THREE.InstancedMesh;
  private readonly torso: THREE.InstancedMesh;
  private readonly upperArm: THREE.InstancedMesh;
  private readonly lowerArm: THREE.InstancedMesh;
  private readonly upperLeg: THREE.InstancedMesh;
  private readonly lowerLeg: THREE.InstancedMesh;
  private readonly foot: THREE.InstancedMesh;

  constructor(
    readonly count: number,
    material: THREE.Material,
  ) {
    this.group.name = 'pedestrians';
    this.dims = Array.from({ length: count }, emptyDims);
    const geo = createGeometries();
    const make = (g: THREE.BufferGeometry, n: number, name: string) => {
      const mesh = new THREE.InstancedMesh(g, material, Math.max(1, n));
      mesh.name = name;
      mesh.count = n;
      mesh.frustumCulled = false; // instances move every frame; the initial bounds would go stale
      this.group.add(mesh);
      return mesh;
    };
    this.head = make(geo.head, count, 'head');
    this.torso = make(geo.torso, count, 'torso');
    this.upperArm = make(geo.upperArm, count * 2, 'upperArm');
    this.lowerArm = make(geo.lowerArm, count * 2, 'lowerArm');
    this.upperLeg = make(geo.upperLeg, count * 2, 'upperLeg');
    this.lowerLeg = make(geo.lowerLeg, count * 2, 'lowerLeg');
    this.foot = make(geo.foot, count * 2, 'foot');
    this.meshes = [this.head, this.torso, this.upperArm, this.lowerArm, this.upperLeg, this.lowerLeg, this.foot];
  }

  /** Draw only the first `n` people (when fewer than `count` could be placed). */
  setActive(n: number): void {
    const people = Math.max(0, Math.min(n, this.count));
    for (const mesh of this.meshes) mesh.count = mesh === this.head || mesh === this.torso ? people : people * 2;
  }

  /** Set a person's height and build. */
  setShape(index: number, shape: PersonShape): void {
    fillDims(this.dims[index], shape);
  }

  /** Pose person `index` and write their body parts into the instance buffers. */
  setPose(index: number, p: PoseInput): void {
    const d = this.dims[index];
    const H = d.height;
    const gait = Math.min(p.speed / REFERENCE_SPEED, 1.4); // 0 standing, 1 at a normal walk
    const idle = 1 - Math.min(1, gait * 3);
    const s = p.stumble;

    // --- legs: angles first, because the pelvis height depends on both ---
    let pelvisH = 0;
    const thigh = [0, 0];
    const knee = [0, 0];
    for (let side = 0; side < 2; side++) {
      const ph = p.phase + (side === 0 ? 0 : Math.PI);
      const walkThigh = LEG_AMP * gait * Math.sin(ph);
      const walkKnee = gait * (0.12 + KNEE_AMP * 0.55 * Math.max(0, Math.cos(ph)));
      thigh[side] = lerp(walkThigh, STUMBLE_THIGH[side], s);
      knee[side] = lerp(walkKnee, STUMBLE_KNEE[side], s);
      // forward kinematics: how far below the hip is the sole?
      const drop = d.legU * Math.cos(thigh[side]) + d.legL * Math.cos(thigh[side] - knee[side]) + d.footH;
      if (drop > pelvisH) pelvisH = drop;
    }

    // --- body frame: pelvis centre, facing yaw ---
    trs(root, p.x, p.y + pelvisH, p.z, 0, p.yaw, 0);

    // --- torso: forward lean, hip/shoulder twist, idle sway, stumble lean ---
    const sway = idle * Math.sin(p.time * 0.6 + p.seed) * 0.03;
    const breath = idle * Math.sin(p.time * 1.9 + p.seed * 1.7) * 0.012;
    const pitch = 0.06 * gait + breath + s * p.leanPitch;
    const roll = sway - s * p.leanRoll; // rotation about +Z leans the head towards -X, so negate the left-positive lean
    const twist = -0.14 * gait * Math.sin(p.phase) + s * 0.35 * Math.sin(p.stumbleTime * 9);
    trs(local, 0, 0, 0, pitch, twist, roll);
    torsoM.multiplyMatrices(root, local);
    put(this.torso, index, torsoM, d.torsoW, d.torsoLen + 0.02 * H, d.torsoD);

    // --- head ---
    trs(local, 0, d.torsoLen + 0.02 * H + d.headD / 2, 0.012 * H, -pitch * 0.5, -twist * 0.6, 0);
    partM.multiplyMatrices(torsoM, local);
    put(this.head, index, partM, d.headD * 0.92, d.headD * 1.08, d.headD);

    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1; // +X is the left side
      const ph = p.phase + (side === 0 ? 0 : Math.PI);
      const slot = index * 2 + side;

      // --- arm: swings opposite to the leg on the same side ---
      const flail = 1.1 + 0.6 * Math.sin(p.stumbleTime * 13 + sgn * 1.7 + p.seed);
      const armForward = lerp(-ARM_AMP * gait * Math.sin(ph) + idle * 0.02 * Math.sin(p.time * 1.3 + side), flail, s);
      const abduct = s * (0.75 + 0.3 * Math.sin(p.stumbleTime * 11 + sgn + p.seed));
      const elbow = lerp(0.25 + 0.3 * gait + 0.2 * gait * Math.max(0, Math.sin(ph)), 0.6, s);
      trs(local, sgn * d.shoulderX, d.shoulderY, 0, -armForward, 0, sgn * (0.04 + abduct));
      shoulderM.multiplyMatrices(torsoM, local);
      put(this.upperArm, slot, shoulderM, d.armUD, d.armU, d.armUD);
      trs(local, 0, -d.armU, 0, -elbow, 0, 0);
      lowerM.multiplyMatrices(shoulderM, local);
      put(this.lowerArm, slot, lowerM, d.armLD, d.armL, d.armLD);

      // --- leg ---
      trs(local, sgn * d.hipX, 0, 0, -thigh[side], 0, 0);
      upperM.multiplyMatrices(root, local);
      put(this.upperLeg, slot, upperM, d.legUD, d.legU, d.legUD);
      trs(local, 0, -d.legU, 0, knee[side], 0, 0);
      lowerM.multiplyMatrices(upperM, local);
      put(this.lowerLeg, slot, lowerM, d.legLD, d.legL, d.legLD);
      // foot stays flat on the ground whatever the leg does
      trs(local, 0, -d.legL, 0, thigh[side] - knee[side], 0, 0);
      partM.multiplyMatrices(lowerM, local);
      put(this.foot, slot, partM, d.footW, d.footH, d.footL);
    }
  }

  /** Upload the instance buffers; call once per frame after all setPose() calls. */
  commit(): void {
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.group.removeFromParent();
  }
}
