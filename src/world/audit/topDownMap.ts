/**
 * src/world/audit/topDownMap.ts: one-off top-down image of the whole play corridor
 *
 * Shared by the audit report (src/world/audit/report.ts, collision heatmap) and the start screen's
 * route picker (src/hud/routePicker.ts, start and goal points).
 *
 * captureTopDownMap() moves the shared camera to a near-orthographic top-down pose (5° FOV from
 * high up), asks the tiles for one LOD update at that pose, renders the already-loaded world once,
 * copies the WebGL frame into a 2D canvas and puts the camera back exactly as it was. Nothing runs
 * per frame. worldToMap() / mapToWorld() convert between local X/Z metres and 0..1 image coordinates.
 */
import * as THREE from 'three';
import { CORRIDOR_BEARING, CORRIDOR_HALF_WIDTH, CORRIDOR_LENGTH } from '../../config';
import { sonarUniforms } from '../../render/sonarMaterial';
import type { World } from '../index';
import { getTiles } from '../tiles';

/** Temporary camera settings used only for the snapshot. */
const SNAPSHOT_FOV = 5;
const SNAPSHOT_FAR_MIN = 2000;
/** Default world-space breathing room around the corridor (m). */
const DEFAULT_PADDING_M = 8;

/** How the captured image maps onto the ground plane. */
export interface TopDownView {
  /** Centre of the image in local world metres. */
  centerX: number;
  centerZ: number;
  /** Camera screen-right and screen-up, projected into the world X/Z plane. */
  rightX: number;
  rightZ: number;
  upX: number;
  upZ: number;
  /** Half-extents of the view on the ground plane (m). */
  halfWidth: number;
  halfHeight: number;
}

export interface TopDownMap {
  /** The captured frame (backing size = the renderer's drawing buffer). */
  image: HTMLCanvasElement;
  view: TopDownView;
}

export interface TopDownOptions {
  /** Extra metres around the corridor. Default 8. */
  paddingM?: number;
  /** Image size in pixels. Default: the renderer's drawing buffer. */
  width?: number;
  height?: number;
  /**
   * Draw the full sonar grid everywhere for this one frame (like the R debug key) instead of only
   * what pings currently reveal. Default false. Sets the uniform directly, so reveal-all listeners
   * (e.g. the debug corridor outline) don't fire.
   */
  revealAll?: boolean;
  /**
   * Draw every surface in grey by its height above the ground instead of with the sonar material
   * (ground black, kerbs and cars dim, buildings white), and hide the agents. A readable street
   * plan, independent of what pings currently reveal. Default false.
   */
  heightShade?: boolean;
  /** Reuse this canvas for the image instead of creating one. */
  into?: HTMLCanvasElement;
}

/**
 * Capture the corridor from above. Returns null (and logs a warning) if rendering failed.
 * The live camera, renderer size and reveal-all state are always restored.
 */
export function captureTopDownMap(world: World, options: TopDownOptions = {}): TopDownMap | null {
  const { camera, renderer } = world;
  const source = renderer.domElement;
  const bufferW = Math.max(1, source.width || window.innerWidth);
  const bufferH = Math.max(1, source.height || window.innerHeight);
  const width = Math.max(1, Math.round(options.width ?? bufferW));
  const height = Math.max(1, Math.round(options.height ?? bufferH));
  const resize = width !== bufferW || height !== bufferH;
  const padding = options.paddingM ?? DEFAULT_PADDING_M;

  const saved = {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    up: camera.up.clone(),
    fov: camera.fov,
    far: camera.far,
    aspect: camera.aspect,
    zoom: camera.zoom,
    revealAll: sonarUniforms.uRevealAll.value,
    override: world.scene.overrideMaterial,
    agentsVisible: world.agentsGroup.visible,
    size: renderer.getSize(new THREE.Vector2()),
    pixelRatio: renderer.getPixelRatio(),
  };

  try {
    if (resize) {
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
    }
    const view = poseTopDown(camera, width / height, padding);

    // One LOD pass for this pose; tile downloads it starts finish asynchronously.
    try {
      const tiles = getTiles();
      if (tiles) {
        tiles.setResolutionFromRenderer(camera, renderer);
        tiles.update();
      }
    } catch (error) {
      console.warn('[topdown] tiles update failed; using the currently visible tiles.', error);
    }

    if (options.revealAll) sonarUniforms.uRevealAll.value = 1;
    if (options.heightShade) {
      world.scene.overrideMaterial = getHeightMaterial();
      world.agentsGroup.visible = false;
    }
    // Render and copy in the same task, so the drawing buffer is still valid.
    renderer.render(world.scene, camera);
    const image = options.into ?? document.createElement('canvas');
    image.width = width;
    image.height = height;
    const ctx = image.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not create a 2D canvas context.');
    ctx.drawImage(source, 0, 0, width, height, 0, 0, width, height);

    return { image, view };
  } catch (error) {
    console.warn('[topdown] could not capture the top-down map:', error);
    return null;
  } finally {
    sonarUniforms.uRevealAll.value = saved.revealAll;
    world.scene.overrideMaterial = saved.override;
    world.agentsGroup.visible = saved.agentsVisible;
    camera.position.copy(saved.position);
    camera.quaternion.copy(saved.quaternion);
    camera.up.copy(saved.up);
    camera.fov = saved.fov;
    camera.far = saved.far;
    camera.aspect = saved.aspect;
    camera.zoom = saved.zoom;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    if (resize) {
      renderer.setPixelRatio(saved.pixelRatio);
      renderer.setSize(saved.size.x, saved.size.y, false);
    }
  }
}

/**
 * Put `cam` in the top-down pose for an image of this aspect ratio and return the matching view.
 * Long road axis along screen-right, road width along screen-up.
 */
function poseTopDown(cam: THREE.PerspectiveCamera, aspect: number, paddingM: number): TopDownView {
  const bearing = THREE.MathUtils.degToRad(CORRIDOR_BEARING);
  const across = new THREE.Vector3(Math.cos(bearing), 0, Math.sin(bearing));
  const target = new THREE.Vector3(0, 0, 0);
  const halfAlong = CORRIDOR_LENGTH / 2 + paddingM;
  const halfAcross = CORRIDOR_HALF_WIDTH + paddingM;
  // FOV is vertical: fit both corridor dimensions at this aspect ratio.
  const halfHeight = Math.max(halfAcross, halfAlong / aspect);
  const altitude = halfHeight / Math.tan(THREE.MathUtils.degToRad(SNAPSHOT_FOV / 2));

  cam.position.set(target.x, target.y + altitude, target.z);
  cam.up.copy(across);
  cam.fov = SNAPSHOT_FOV;
  cam.far = Math.max(SNAPSHOT_FAR_MIN, altitude + 1000);
  cam.aspect = aspect;
  cam.zoom = 1;
  cam.lookAt(target);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);

  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  return {
    centerX: target.x,
    centerZ: target.z,
    rightX: right.x,
    rightZ: right.z,
    upX: up.x,
    upZ: up.z,
    halfWidth: halfHeight * aspect,
    halfHeight,
  };
}

/** Height shading: black at or below HEIGHT_DARK_M above y = 0 (the street), white from HEIGHT_FULL_M up. */
const HEIGHT_DARK_M = 0.8;
const HEIGHT_FULL_M = 9;
let heightMaterial: THREE.ShaderMaterial | null = null;

function getHeightMaterial(): THREE.ShaderMaterial {
  heightMaterial ??= new THREE.ShaderMaterial({
    name: 'topDownHeight',
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying float vY;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vY = wp.y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vY;
      void main() {
        float h = smoothstep(${HEIGHT_DARK_M.toFixed(2)}, ${HEIGHT_FULL_M.toFixed(2)}, vY);
        // a faint floor so the street surface still reads as "something" next to the void
        float g = vY > -50.0 ? 0.08 + 0.92 * h : 0.0;
        gl_FragColor = vec4(vec3(g), 1.0);
      }
    `,
  });
  return heightMaterial;
}

const scratchCamera = new THREE.PerspectiveCamera();

/**
 * The view captureTopDownMap() would produce at this aspect ratio, without rendering anything
 * (e.g. to draw and click on the corridor before the tiles have loaded).
 */
export function topDownView(aspect: number, paddingM = DEFAULT_PADDING_M): TopDownView {
  return poseTopDown(scratchCamera, aspect, paddingM);
}

/** Local X/Z (m) to 0..1 image coordinates (x right, y down). Values outside 0..1 are off the image. */
export function worldToMap(view: TopDownView, x: number, z: number): { u: number; v: number } {
  const dx = x - view.centerX;
  const dz = z - view.centerZ;
  const sx = dx * view.rightX + dz * view.rightZ;
  const sy = dx * view.upX + dz * view.upZ;
  return { u: sx / (view.halfWidth * 2) + 0.5, v: 0.5 - sy / (view.halfHeight * 2) };
}

/** 0..1 image coordinates to local X/Z (m) on the ground plane. Inverse of worldToMap(). */
export function mapToWorld(view: TopDownView, u: number, v: number): { x: number; z: number } {
  const sx = (u - 0.5) * view.halfWidth * 2;
  const sy = (0.5 - v) * view.halfHeight * 2;
  // right and up are orthonormal in X/Z for a straight-down camera, so the inverse is the transpose.
  return {
    x: view.centerX + sx * view.rightX + sy * view.upX,
    z: view.centerZ + sx * view.rightZ + sy * view.upZ,
  };
}
