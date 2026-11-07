/**
 * src/audit/report.ts
 *
 * Snapshot-cache audit report.
 *
 * The first time the report key is pressed, this module temporarily moves the shared camera to a
 * top-down pose, renders the already-loaded world once, and copies the WebGL canvas
 * into this module's 2D canvas. The camera is then restored immediately.
 *
 * All subsequent report drawing is 2D Canvas API work over that cached image. No
 * scene materials are replaced and no shaders are created by this module.
 *
 * The info panel can be minimised (button or click on its title bar) so it does not cover the map.
 *
 * Integration note: the supplied project currently stores the audit modules in
 * src/world/audit/. To activate this file while keeping it in src/audit/, update the
 * dynamic import in src/world/audit/log.ts as described in the accompanying notes.
 */

import * as THREE from 'three';
import {
  CORRIDOR_BEARING,
  CORRIDOR_HALF_WIDTH,
  CORRIDOR_LENGTH,
} from '../../config';
import type { World } from '../index';
import { getTiles } from '../tiles';
import { isRevealAll, setRevealAll } from '../../render/sonarMaterial';
import { captureTopDownMap, worldToMap, type TopDownView } from './topDownMap';
import {
  clearEvents,
  getAllEvents,
  localToLatLon,
  type AuditApi,
  type AuditEvent,
  type AuditableWorld,
} from './log';

// -----------------------------------------------------------------------------
// Configuration and aggregation
// -----------------------------------------------------------------------------

/** Each aggregate cell represents a 2 m × 2 m patch of the local X/Z plane. */
const CELL_SIZE = 2;
const LOW_OBSTACLE_TYPES = new Set(['building', 'low_obstacle', 'street_furniture']);
const HEAT_FULL_SCALE = 5;

/** Temporary camera settings used only for the one-off WebGL snapshot. */
const SNAPSHOT_FOV = 5;
const SNAPSHOT_FAR_MIN = 2000;
/** Extra world-space breathing room around the playable corridor. */
const SNAPSHOT_PADDING_METRES = 8;


interface HotspotCell {
  /** Centre of this cell in local world metres. */
  x: number;
  z: number;
  built: number;
  agent: number;
  total: number;
  types: Map<string, number>;
}

interface Aggregate {
  cells: HotspotCell[];
  top: HotspotCell[];
  maxCount: number;
  eventCount: number;
  runCount: number;
}

type SnapshotView = TopDownView;

interface DrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function aggregate(events: AuditEvent[]): Aggregate {
  const cells = new Map<string, HotspotCell>();
  const runs = new Set<string>();
  let eventCount = 0;

  for (const event of events) {
    const position = event?.position;
    if (
      !position ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.z)
    ) {
      continue;
    }

    eventCount++;
    if (event.runId) runs.add(event.runId);

    const ix = Math.floor(position.x / CELL_SIZE);
    const iz = Math.floor(position.z / CELL_SIZE);
    const key = `${ix},${iz}`;

    let cell = cells.get(key);
    if (!cell) {
      cell = {
        x: (ix + 0.5) * CELL_SIZE,
        z: (iz + 0.5) * CELL_SIZE,
        built: 0,
        agent: 0,
        total: 0,
        types: new Map<string, number>(),
      };
      cells.set(key, cell);
    }

    if (LOW_OBSTACLE_TYPES.has(event.hit)) cell.built++;
    else cell.agent++;

    cell.total++;
    cell.types.set(event.hit, (cell.types.get(event.hit) ?? 0) + 1);
  }

  const allCells = [...cells.values()];
  const sorted = allCells.slice().sort((a, b) => b.total - a.total);

  return {
    cells: allCells,
    top: sorted.slice(0, 5),
    maxCount: sorted[0]?.total ?? 0,
    eventCount,
    runCount: runs.size,
  };
}

// -----------------------------------------------------------------------------
// DOM and canvas helpers
// -----------------------------------------------------------------------------

const FONT = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  return node;
}

function styleButton(button: HTMLButtonElement): HTMLButtonElement {
  Object.assign(button.style, {
    font: FONT,
    color: '#fff',
    background: 'rgba(0, 0, 0, 0.92)',
    border: '1px solid rgba(255, 255, 255, 0.8)',
    borderRadius: '2px',
    padding: '7px 11px',
    cursor: 'pointer',
    marginLeft: '8px',
    pointerEvents: 'auto',
  } as Partial<CSSStyleDeclaration>);
  return button;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Centre a cached snapshot inside the current canvas without distorting its aspect ratio. */
function containRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): DrawRect {
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}

function interpolateHotspotColour(intensity: number): { red: number; green: number; blue: number } {
  // Low density is yellow; high density shifts towards red.
  const t = clamp(intensity, 0, 1);
  return {
    red: 255,
    green: Math.round(230 * (1 - t) + 24 * t),
    blue: Math.round(12 * (1 - t)),
  };
}

// -----------------------------------------------------------------------------
// Report
// -----------------------------------------------------------------------------

/** Install the report UI and keyboard handlers. Returns a dispose function. */
export function initReport(world: World): () => void {
  const w = world as AuditableWorld;

  // The visible report canvas is an HTML canvas layered over the game.
  const root = makeElement('div', {
    position: 'fixed',
    inset: '0',
    zIndex: '1000',
    display: 'none',
    color: '#fff',
    font: FONT,
    pointerEvents: 'none',
    overflow: 'hidden',
    background: '#000',
  });

  const canvas = makeElement('canvas', {
    position: 'absolute',
    inset: '0',
    display: 'block',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  });
  canvas.setAttribute('aria-label', 'Cached top-down world image with collision heatmap');

  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('[audit] Could not create the 2D report canvas context.');

  // Keep an untouched copy of the captured WebGL frame. The visible canvas is redrawn
  // from this cache before every heatmap refresh, so hotspots never accumulate.
  const snapshotCanvas = document.createElement('canvas');
  const snapshotContext = snapshotCanvas.getContext('2d', { alpha: false });
  if (!snapshotContext) throw new Error('[audit] Could not create the snapshot cache context.');

  // --- info panel: a persistent title bar (with minimise button) above a body that is rebuilt on refresh ---
  const PANEL_WIDTH = 'min(420px, calc(100vw - 48px))';

  const panel = makeElement('div', {
    position: 'absolute',
    zIndex: '2',
    top: '12px',
    left: '12px',
    width: PANEL_WIDTH,
    boxSizing: 'border-box',
    padding: '10px 12px',
    border: '1px solid rgba(255,255,255,0.9)',
    background: 'rgba(0,0,0,0.88)',
    lineHeight: '1.5',
    pointerEvents: 'auto',
  });

  const panelHeader = makeElement('div', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    cursor: 'pointer',
    userSelect: 'none',
  });
  const panelTitle = makeElement('div', { fontWeight: 'bold', fontSize: '13px' }, 'AUDIT: collision heatmap');
  const panelToggle = styleButton(makeElement('button', {}, '–'));
  Object.assign(panelToggle.style, { marginLeft: '0', padding: '0 9px', lineHeight: '20px' });
  panelHeader.append(panelTitle, panelToggle);

  const panelBody = makeElement('div', {
    maxHeight: 'calc(100vh - 150px)',
    overflowY: 'auto',
  });
  panel.append(panelHeader, panelBody);

  let panelCollapsed = false;
  function setPanelCollapsed(collapsed: boolean): void {
    panelCollapsed = collapsed;
    panelBody.style.display = collapsed ? 'none' : 'block';
    panel.style.width = collapsed ? 'auto' : PANEL_WIDTH;
    panel.style.minWidth = collapsed ? '210px' : '';
    panelToggle.textContent = collapsed ? '+' : '–';
    panelToggle.title = collapsed ? 'Show panel' : 'Minimise panel';
    panelToggle.setAttribute('aria-label', panelToggle.title);
    panelToggle.setAttribute('aria-expanded', String(!collapsed));
  }
  setPanelCollapsed(false);
  // One handler on the header covers both the title bar and the button (clicks bubble up).
  panelHeader.addEventListener('click', () => setPanelCollapsed(!panelCollapsed));

  const buttons = makeElement('div', {
    position: 'absolute',
    zIndex: '2',
    top: '12px',
    right: '12px',
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: '6px',
    pointerEvents: 'auto',
  });

  const recaptureButton = styleButton(makeElement('button', {}, 'Recapture map'));
  const exportButton = styleButton(makeElement('button', {}, 'Export JSON'));
  const clearButton = styleButton(makeElement('button', {}, 'Clear data'));
  buttons.append(recaptureButton, exportButton, clearButton);

  const footer = makeElement('div', {
    position: 'absolute',
    zIndex: '2',
    left: '12px',
    right: '12px',
    bottom: '10px',
    fontSize: '11px',
    lineHeight: '1.4',
    opacity: '0.95',
    textShadow: '0 0 4px #000, 0 0 7px #000',
    pointerEvents: 'none',
  });

  root.append(canvas, panel, buttons, footer);
  document.body.appendChild(root);

  const camera = world.camera;
  let open = false;
  let refreshToken = 0;
  let snapshotView: SnapshotView | null = null;
  let lastAggregate: Aggregate = aggregate([]);
  let snapshotError = '';

  // ---------------------------------------------------------------------------
  // Canvas dimensions and snapshot capture
  // ---------------------------------------------------------------------------

  function fitCanvasToRenderer(): void {
    const source = world.renderer.domElement;
    const width = Math.max(1, source.width || window.innerWidth);
    const height = Math.max(1, source.height || window.innerHeight);

    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    // CSS sizing stays full-screen; backing pixels match the WebGL drawing buffer.
    canvas.style.width = '100%';
    canvas.style.height = '100%';
  }

  /**
   * Capture the currently loaded 3D scene once (src/world/audit/topDownMap.ts, shared with the
   * start screen's route picker). The live camera is restored inside captureTopDownMap().
   */
  function captureSnapshot(): boolean {
    fitCanvasToRenderer();
    const map = captureTopDownMap(world, { paddingM: SNAPSHOT_PADDING_METRES, into: snapshotCanvas });
    if (!map) {
      snapshotError = 'Could not render the top-down view (see the console).';
      return false;
    }
    const source = world.renderer.domElement;
    const sourceWidth = Math.max(1, source.width || window.innerWidth);
    const sourceHeight = Math.max(1, source.height || window.innerHeight);
    // The report is a map of the whole playable corridor, not a view centred on
    // wherever the player happens to be when the report opens.
    const target = new THREE.Vector3(0, 0, 0);

    // The game is drawn with a sonar mask that hides everything the player hasn't "heard", so without
    // this the overview is black (only the player's arm's reach would show). Reveal the whole grid for
    // this one render and hide the moving things (people, cars, the entity) so the map is clean.
    const savedRevealAll = isRevealAll();
    const entityBody = world.scene.getObjectByName('entity');
    const savedAgentsVisible = world.agentsGroup.visible;
    const savedEntityVisible = entityBody?.visible ?? true;

    const savedCamera = {
      position: camera.position.clone(),
      rotation: camera.rotation.clone(),
      up: camera.up.clone(),
      fov: camera.fov,
      far: camera.far,
      near: camera.near,
      aspect: camera.aspect,
      zoom: camera.zoom,
    };

    const bearing = THREE.MathUtils.degToRad(CORRIDOR_BEARING);
    // World-space corridor basis: along the road and across it. For a landscape
    // overview, align the long road axis with screen-right and the road width with
    // screen-up. A top-down camera's `up` vector therefore points across the road.
    const corridorAcross = new THREE.Vector3(Math.cos(bearing), 0, Math.sin(bearing));

    try {
      setRevealAll(true);
      world.agentsGroup.visible = false;
      if (entityBody) entityBody.visible = false;
      fitCanvasToRenderer();

      const aspect = sourceWidth / sourceHeight;
      const halfAlong = CORRIDOR_LENGTH / 2 + SNAPSHOT_PADDING_METRES;
      const halfAcross = CORRIDOR_HALF_WIDTH + SNAPSHOT_PADDING_METRES;

      // Perspective camera FOV is vertical. Fit both corridor dimensions while
      // preserving the renderer's aspect ratio. On a narrow/portrait canvas the
      // required altitude rises automatically so neither end of the corridor clips.
      const requiredHalfViewHeight = Math.max(halfAcross, halfAlong / aspect);
      const cameraHeight = requiredHalfViewHeight /
        Math.tan(THREE.MathUtils.degToRad(SNAPSHOT_FOV / 2));

      camera.position.set(target.x, target.y + cameraHeight, target.z);
      camera.up.copy(corridorAcross);
      camera.fov = SNAPSHOT_FOV;
      camera.far = Math.max(SNAPSHOT_FAR_MIN, cameraHeight + 1000);
      camera.aspect = aspect;
      camera.lookAt(target);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);

      // Re-evaluate the loaded tile set for this camera pose. This is one update, not
      // a per-frame camera/LOD loop; any newly requested tile loads complete asynchronously.
      try {
        const tiles = getTiles();
        if (tiles) {
          tiles.setResolutionFromRenderer(camera, world.renderer);
          tiles.update();
        }
      } catch (error) {
        console.warn('[audit] TilesRenderer snapshot update failed; using currently visible tiles.', error);
      }

      // Required synchronous WebGL render, followed immediately by a 2D canvas copy.
      world.renderer.render(world.scene, camera);
      context!.drawImage(source, 0, 0, sourceWidth, sourceHeight);

      // Copy the just-captured WebGL frame to the persistent cache before any heat is drawn.
      snapshotCanvas.width = sourceWidth;
      snapshotCanvas.height = sourceHeight;
      snapshotContext!.drawImage(canvas, 0, 0, sourceWidth, sourceHeight);

      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
      const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();

      const distance = Math.abs((target.y - camera.position.y) / (forward.y || -1));
      const halfHeight = distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const halfWidth = halfHeight * camera.aspect;

      snapshotView = {
        centerX: target.x,
        centerZ: target.z,
        rightX: right.x,
        rightZ: right.z,
        upX: screenUp.x,
        upZ: screenUp.z,
        halfWidth,
        halfHeight,
      };

      snapshotError = '';
      console.info(
        `[audit] cached full-corridor snapshot (${sourceWidth}×${sourceHeight}, ` +
        `about ${(halfWidth * 2).toFixed(1)} m along × ${(halfHeight * 2).toFixed(1)} m across; ` +
        `camera altitude ${cameraHeight.toFixed(0)} m)`,
      );
      return true;
    } catch (error) {
      snapshotError = error instanceof Error ? error.message : String(error);
      console.warn('[audit] Could not capture the world snapshot:', error);
      return false;
    } finally {
      setRevealAll(savedRevealAll);
      world.agentsGroup.visible = savedAgentsVisible;
      if (entityBody) entityBody.visible = savedEntityVisible;
      // Restore the live player camera exactly as it was before the snapshot.
      camera.position.copy(savedCamera.position);
      camera.rotation.copy(savedCamera.rotation);
      camera.up.copy(savedCamera.up);
      camera.fov = savedCamera.fov;
      camera.far = savedCamera.far;
      camera.near = savedCamera.near;
      camera.aspect = savedCamera.aspect;
      camera.zoom = savedCamera.zoom;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
    }
  }

  // ---------------------------------------------------------------------------
  // 2D rendering: cached background + radial-gradient hotspots
  // ---------------------------------------------------------------------------

  function drawHotspots(data: Aggregate, mapRect: DrawRect): void {
    if (!context || !snapshotView || data.cells.length === 0) return;

    const view = snapshotView;
    const pixelsPerMetre = Math.min(
      mapRect.width / (view.halfWidth * 2),
      mapRect.height / (view.halfHeight * 2),
    );
    const denominator = Math.max(data.maxCount, HEAT_FULL_SCALE);

    // Screen blending makes the glow visible over dark and light parts of the cached map.
    context.save();
    context.globalCompositeOperation = 'screen';

    // Draw weaker cells first so the most intense cells remain visible on top.
    const ordered = data.cells.slice().sort((a, b) => a.total - b.total);

    for (const cell of ordered) {
      // Project local X/Z into the snapshot image (0..1).
      const { u: nx, v: ny } = worldToMap(view, cell.x, cell.z);

      // Skip hotspots outside the captured world rectangle.
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;

      const x = mapRect.x + nx * mapRect.width;
      const y = mapRect.y + ny * mapRect.height;
      const intensity = clamp(cell.total / denominator, 0, 1);
      const colour = interpolateHotspotColour(intensity);
      const radius = clamp(CELL_SIZE * pixelsPerMetre * 0.7 + Math.log2(cell.total + 1) * 2, 10, 64);
      const alpha = 0.28 + intensity * 0.5;

      const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(
        0,
        `rgba(${colour.red}, ${colour.green}, ${colour.blue}, ${alpha})`,
      );
      gradient.addColorStop(
        0.32,
        `rgba(${colour.red}, ${colour.green}, ${colour.blue}, ${alpha * 0.68})`,
      );
      gradient.addColorStop(
        1,
        `rgba(${colour.red}, ${colour.green}, ${colour.blue}, 0)`,
      );

      context.fillStyle = gradient;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }

    context.restore();
  }

  function drawCanvas(data: Aggregate): void {
    if (!context) return;
    fitCanvasToRenderer();

    const width = canvas.width;
    const height = canvas.height;

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);

    if (snapshotView && snapshotCanvas.width > 0 && snapshotCanvas.height > 0) {
      const rect = containRect(snapshotCanvas.width, snapshotCanvas.height, width, height);
      context.imageSmoothingEnabled = true;
      context.drawImage(snapshotCanvas, rect.x, rect.y, rect.width, rect.height);
      context.restore();
      drawHotspots(data, rect);
      return;
    }

    context.fillStyle = '#fff';
    context.font = FONT;
    context.textAlign = 'center';
    context.fillText(
      snapshotError
        ? `Snapshot failed: ${snapshotError}`
        : 'Press M to capture the top-down world snapshot.',
      width / 2,
      height / 2,
      Math.max(100, width - 40),
    );
    context.restore();
  }

  // ---------------------------------------------------------------------------
  // Panel and attributions
  // ---------------------------------------------------------------------------

  function renderPanel(data: Aggregate): void {
    // Only the body is rebuilt; the title bar and minimised/expanded state persist.
    panelBody.replaceChildren();

    panelBody.append(
      makeElement(
        'div',
        { marginTop: '3px', opacity: '0.85' },
        `${data.eventCount} events · ${data.runCount} run${data.runCount === 1 ? '' : 's'} · ${CELL_SIZE} m cells`,
      ),
    );

    const legend = makeElement('div', {
      marginTop: '8px',
      height: '8px',
      background: 'linear-gradient(to right, #ffe61a, #ff8a00, #ff1800)',
    });
    panelBody.append(legend);

    const legendLabels = makeElement('div', {
      display: 'flex',
      justifyContent: 'space-between',
      opacity: '0.8',
      fontSize: '11px',
    });
    legendLabels.append(makeElement('span', {}, 'Few collisions'), makeElement('span', {}, 'Many collisions'));
    panelBody.append(legendLabels);

    panelBody.append(makeElement('div', { marginTop: '9px', fontWeight: 'bold' }, 'Top 5 Hotspots'));

    if (data.top.length === 0) {
      panelBody.append(makeElement('div', { marginTop: '4px', opacity: '0.7' }, 'No events recorded yet. Press J to inject test events.'));
    }

    data.top.forEach((cell, index) => {
      const { lat, lon } = localToLatLon(cell.x, cell.z);
      const typeSummary = [...cell.types.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `${type} × ${count}`)
        .join(', ');

      const row = makeElement('div', {
        marginTop: '7px',
        paddingTop: '5px',
        borderTop: '1px solid rgba(255,255,255,0.18)',
      });
      row.append(
        makeElement('div', { fontWeight: 'bold' }, `#${index + 1} · ${cell.total} collision${cell.total === 1 ? '' : 's'}`),
        makeElement('div', { opacity: '0.85' }, `Local: X ${cell.x.toFixed(1)} m, Z ${cell.z.toFixed(1)} m`),
        makeElement('div', { opacity: '0.85' }, `GPS: ${lat.toFixed(5)}, ${lon.toFixed(5)}`),
        makeElement('div', { opacity: '0.75', overflowWrap: 'anywhere' }, typeSummary),
      );
      panelBody.append(row);
    });

    panelBody.append(
      makeElement(
        'div',
        { marginTop: '9px', opacity: '0.65', fontSize: '11px' },
        'M close · J inject 20 test events · Recapture map to update the cached background',
      ),
    );
  }

  function renderFooter(): void {
    const attributionParts = [
      'Google Maps',
      ...(w.attributions ?? []),
      '© OpenStreetMap contributors',
    ].filter(Boolean);
    footer.textContent = attributionParts.join(' · ');
  }

  function render(data: Aggregate): void {
    drawCanvas(data);
    renderPanel(data);
    renderFooter();
  }

  // ---------------------------------------------------------------------------
  // Data refresh, export and clear
  // ---------------------------------------------------------------------------

  async function refresh(): Promise<void> {
    const mine = ++refreshToken;
    try {
      const events = await getAllEvents();
      if (mine !== refreshToken || !open) return;
      lastAggregate = aggregate(events);
      render(lastAggregate);
    } catch (error) {
      console.warn('[audit] Could not load stored audit events:', error);
      if (mine === refreshToken && open) {
        panelBody.replaceChildren(
          makeElement('div', { marginTop: '6px' }, 'Could not load audit events. See the console for details.'),
        );
      }
    }
  }

  async function exportJson(): Promise<void> {
    try {
      const events = await getAllEvents();
      const payload = JSON.stringify(
        { exportedAt: new Date().toISOString(), events },
        null,
        2,
      );
      const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      const anchor = makeElement('a');
      anchor.href = url;
      anchor.download = `blind-simulator-audit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.warn('[audit] JSON export failed:', error);
    }
  }

  async function clearData(): Promise<void> {
    if (!window.confirm('Delete all stored audit runs? This cannot be undone.')) return;
    try {
      await clearEvents();
      lastAggregate = aggregate([]);
      if (open) render(lastAggregate);
    } catch (error) {
      console.warn('[audit] Could not clear audit data:', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Dev test: J injects 20 synthetic events around the snapshot centre/player
  // ---------------------------------------------------------------------------

  function injectFakeEvents(): void {
    const audit: AuditApi | undefined = w.audit;
    if (!audit) {
      console.warn('[audit] world.audit is not installed; call initAudit(world) first.');
      return;
    }

    const origin = snapshotView
      ? { x: snapshotView.centerX, y: camera.position.y, z: snapshotView.centerZ }
      : camera.position;
    const randomBetween = (min: number, max: number): number => min + Math.random() * (max - min);
    const centres = Array.from({ length: 5 }, () => ({
      x: origin.x + randomBetween(-8, 8),
      z: origin.z + randomBetween(-8, 8),
    }));

    const hitWeights: Array<[string, number]> = [
      ['building', 0.35],
      ['low_obstacle', 0.2],
      ['street_furniture', 0.15],
      ['pedestrian', 0.15],
      ['car', 0.05],
      ['entity', 0.1],
    ];

    const pickHit = (): string => {
      let remaining = Math.random();
      for (const [hit, weight] of hitWeights) {
        remaining -= weight;
        if (remaining <= 0) return hit;
      }
      return 'building';
    };

    for (let index = 0; index < 20; index++) {
      const centre = centres[Math.floor(Math.random() * centres.length)];
      const position = {
        x: centre.x + randomBetween(-0.9, 0.9),
        y: origin.y,
        z: centre.z + randomBetween(-0.9, 0.9),
      };
      const angle = randomBetween(0, Math.PI * 2);
      const normal = { x: Math.cos(angle), y: 0, z: Math.sin(angle) };
      const impactSpeed = randomBetween(0.5, 5.5);

      if (index < 4) {
        // Exercise the log's height-based classification (two low, two high).
        audit.log({
          position,
          point: { ...position, y: index % 2 === 0 ? 0.3 : 1.3 },
          normal,
          impactSpeed,
          synthetic: true,
        });
        continue;
      }

      const hit = pickHit();
      audit.log({
        kind: hit === 'entity' ? 'caught' : 'collision',
        hit,
        position,
        normal,
        impactSpeed,
        caneActive: Math.random() < 0.5,
        synthetic: true,
      });
    }

    console.info('[audit] injected 20 synthetic events (J)');
    if (open) void refresh();
  }

  // ---------------------------------------------------------------------------
  // Open/close and keyboard events
  // ---------------------------------------------------------------------------

  function setOpen(value: boolean): void {
    if (value === open) return;
    open = value;
    root.style.display = open ? 'block' : 'none';

    if (open) {
      // Release pointer lock so the report UI remains usable.
      document.exitPointerLock?.();

      // First open takes the one-time snapshot. Later opens reuse the cached image.
      if (!snapshotView) captureSnapshot();

      render(lastAggregate);
      void refresh();
    } else {
      refreshToken++;
    }
  }

  recaptureButton.addEventListener('click', () => {
    if (captureSnapshot()) render(lastAggregate);
    else drawCanvas(lastAggregate);
  });
  exportButton.addEventListener('click', () => void exportJson());
  clearButton.addEventListener('click', () => void clearData());

  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.code === 'KeyV') {
      setOpen(!open);
    } else if (event.code === 'KeyJ') {
      injectFakeEvents();
    }
  };

  const onResize = (): void => {
    if (!open) return;
    drawCanvas(lastAggregate);
  };

  // Capture-phase listener intentionally reserves the report key for the audit report.
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onResize);

  return () => {
    setOpen(false);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onResize);
    root.remove();
  };
}