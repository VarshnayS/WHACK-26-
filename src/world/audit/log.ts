/**
 * src/audit/log.ts: collision / caught event log (Tier 1)
 * Owner: AUDIT agent. Edits only in src/audit/.
 *
 * initAudit(world) installs `world.audit`. Other modules log with:
 *
 *   world.audit.log({ hit: 'building', impactSpeed, normal, point, caneActive });
 *
 * Everything is stored client-side only: IndexedDB, falling back to localStorage, falling
 * back to memory. No server, no new dependencies.
 */
import { ORIGIN_LAT, ORIGIN_LON, XZ_OFFSET, YAW_OFFSET } from '../../config';
import type { World } from '../index';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** What happened: a collision with something, or the entity catching the player. */
export type EventKind = 'collision' | 'caught';

/**
 * What was hit. Built environment: building, low_obstacle, street_furniture.
 * Everything else (pedestrian, car, entity, ...) is treated as an agent/entity hit by the report.
 */
export type HitType = 'building' | 'low_obstacle' | 'street_furniture' | 'pedestrian' | 'car' | 'entity';

/** Stored event (one row). */
export interface AuditEvent {
  /** Auto-assigned by IndexedDB; absent in the localStorage / memory fallbacks. */
  seq?: number;
  runId: string;
  /** Milliseconds since the Unix epoch (Date.now()). */
  timestamp: number;
  /** Player position in local metres (+X west, +Z north, y up). */
  position: Vec3Like;
  lat: number;
  lon: number;
  kind: EventKind;
  /** What was hit (see HitType). Classified from height if the caller gave none. */
  hit: string;
  impactSpeed: number;
  /** Surface normal at impact, or null if unknown. */
  normal: Vec3Like | null;
  caneActive: boolean;
  /** world.vision.id, or null if the world has no vision. */
  visionId: string | null;
  /** True for events injected by the J dev test. */
  synthetic?: boolean;
}

/** What callers pass to world.audit.log(). Everything is optional. */
export interface AuditInput {
  /** Default 'collision'. */
  kind?: EventKind;
  /** If omitted, classified from the contact height (see classifyByHeight). */
  hit?: string;
  /** Default: the camera position. */
  position?: Vec3Like;
  /** Contact point on the obstacle; its y is used for classification. */
  point?: Vec3Like;
  impactSpeed?: number;
  normal?: Vec3Like;
  /** Default false. */
  caneActive?: boolean;
  synthetic?: boolean;
}

export interface AuditApi {
  readonly runId: string;
  /** Build, store and return an event. */
  log(input?: AuditInput): AuditEvent;
  /** Every stored event across all runs. */
  getEvents(): Promise<AuditEvent[]>;
  clear(): Promise<void>;
}

/** Optional fields the audit code uses on `world` (not all exist in the shared World yet). */
export interface AuditExtras {
  audit?: AuditApi;
  vision?: { id?: string | number | null };
  on?: (event: string, fn: (...args: unknown[]) => void) => unknown;
}
export type AuditableWorld = World & AuditExtras;

// ---------------------------------------------------------------------------
// Coordinates: local metres -> lat/lon
// ---------------------------------------------------------------------------

/**
 * Inverse of latLonToLocal() in src/world/osm.ts, using the axis notes in src/config.ts:
 * +X = west, +Z = north, origin at ORIGIN_LAT/LON, with YAW_OFFSET (about +Y) and XZ_OFFSET
 * applied to the local frame. Uses the standard metres-per-degree series for WGS84, which is
 * accurate to well under a metre over the 200 m corridor.
 */
export function localToLatLon(x: number, z: number): { lat: number; lon: number } {
  // Undo XZ_OFFSET, then undo the YAW_OFFSET rotation about +Y (same maths as THREE's applyAxisAngle).
  let px = x - XZ_OFFSET.x;
  let pz = z - XZ_OFFSET.z;
  if (YAW_OFFSET !== 0) {
    const c = Math.cos(-YAW_OFFSET);
    const s = Math.sin(-YAW_OFFSET);
    const rx = px * c + pz * s;
    const rz = -px * s + pz * c;
    px = rx;
    pz = rz;
  }
  const east = -px; // +X is west
  const north = pz;

  const phi = (ORIGIN_LAT * Math.PI) / 180;
  const metresPerDegLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const metresPerDegLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);
  return {
    lat: ORIGIN_LAT + north / metresPerDegLat,
    lon: ORIGIN_LON + east / metresPerDegLon,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Contact below this height (metres) is a low obstacle (kerb, bollard base, bin). */
const LOW_OBSTACLE_MAX_Y = 0.5;

/**
 * Used when an event has no `hit`: a contact below ~0.5 m is a 'low_obstacle'; anything higher
 * (a tall vertical surface) is a 'building'. If the caller gave no contact point at all, the
 * hit is assumed to be a tall wall, i.e. 'building'.
 */
export function classifyByHeight(contactY: number | undefined): HitType {
  if (contactY !== undefined && Number.isFinite(contactY) && contactY < LOW_OBSTACLE_MAX_Y) {
    return 'low_obstacle';
  }
  return 'building';
}

// ---------------------------------------------------------------------------
// Storage: IndexedDB -> localStorage -> memory
// ---------------------------------------------------------------------------

interface AuditStore {
  add(event: AuditEvent): Promise<void>;
  all(): Promise<AuditEvent[]>;
  clear(): Promise<void>;
}

const DB_NAME = 'blind-simulator-audit';
const DB_STORE = 'events';
const LS_KEY = 'blind-simulator-audit-events';
const LS_MAX_EVENTS = 5000;

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function openIndexedDbStore(): Promise<AuditStore> {
  if (typeof indexedDB === 'undefined') throw new Error('indexedDB unavailable');
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      const database = open.result;
      if (!database.objectStoreNames.contains(DB_STORE)) {
        const store = database.createObjectStore(DB_STORE, { keyPath: 'seq', autoIncrement: true });
        store.createIndex('runId', 'runId');
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return {
    async add(event) {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).add(event);
      await transactionDone(tx);
    },
    async all() {
      const tx = db.transaction(DB_STORE, 'readonly');
      return (await requestToPromise(tx.objectStore(DB_STORE).getAll())) as AuditEvent[];
    },
    async clear() {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
      await transactionDone(tx);
    },
  };
}

function openLocalStorageStore(): AuditStore {
  localStorage.getItem(LS_KEY); // throws if storage is blocked, which triggers the next fallback
  const read = (): AuditEvent[] => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
      return Array.isArray(parsed) ? (parsed as AuditEvent[]) : [];
    } catch {
      return [];
    }
  };
  const write = (events: AuditEvent[]): void => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(events));
    } catch {
      // Quota exceeded: drop the oldest half and try once more.
      localStorage.setItem(LS_KEY, JSON.stringify(events.slice(Math.floor(events.length / 2))));
    }
  };
  return {
    async add(event) {
      const events = read();
      events.push(event);
      write(events.length > LS_MAX_EVENTS ? events.slice(events.length - LS_MAX_EVENTS) : events);
    },
    async all() {
      return read();
    },
    async clear() {
      localStorage.removeItem(LS_KEY);
    },
  };
}

function openMemoryStore(): AuditStore {
  let events: AuditEvent[] = [];
  return {
    async add(event) {
      events.push(event);
    },
    async all() {
      return events.slice();
    },
    async clear() {
      events = [];
    },
  };
}

async function openStore(): Promise<AuditStore> {
  try {
    return await openIndexedDbStore();
  } catch (err) {
    console.warn('[audit] IndexedDB unavailable, falling back to localStorage:', err);
  }
  try {
    return openLocalStorageStore();
  } catch (err) {
    console.warn('[audit] localStorage unavailable, events will only be kept in memory:', err);
  }
  return openMemoryStore();
}

let storePromise: Promise<AuditStore> | null = null;
/** Serialises writes so events are stored in the order they were logged. */
let writeQueue: Promise<void> = Promise.resolve();

function getStore(): Promise<AuditStore> {
  storePromise ??= openStore();
  return storePromise;
}

function enqueue(task: (store: AuditStore) => Promise<void>): void {
  writeQueue = writeQueue
    .then(async () => task(await getStore()))
    .catch((err) => console.warn('[audit] storage write failed:', err));
}

/** Every stored event across all runs (waits for pending writes first). */
export async function getAllEvents(): Promise<AuditEvent[]> {
  const store = await getStore();
  await writeQueue;
  return store.all();
}

/** Delete every stored event (all runs). */
export async function clearEvents(): Promise<void> {
  const store = await getStore();
  await writeQueue;
  await store.clear();
}

// ---------------------------------------------------------------------------
// initAudit
// ---------------------------------------------------------------------------

function makeRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function copyVec(v: Vec3Like): Vec3Like {
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Replace `world.audit` with the real implementation, start listening for 'caught', and set up
 * the report UI (M) and dev test (J). Call once from src/main.ts after the world exists.
 */
export function initAudit(world: World): AuditApi {
  const w = world as AuditableWorld;
  const runId = makeRunId();
  void getStore(); // open storage early

  const api: AuditApi = {
    runId,

    log(input: AuditInput = {}): AuditEvent {
      const p = input.position ?? w.camera.position;
      const kind: EventKind = input.kind ?? 'collision';
      const hit = input.hit ?? (kind === 'caught' ? 'entity' : classifyByHeight(input.point?.y));
      const { lat, lon } = localToLatLon(p.x, p.z);
      const visionId = w.vision?.id;

      const event: AuditEvent = {
        runId,
        timestamp: Date.now(),
        position: copyVec(p),
        lat,
        lon,
        kind,
        hit,
        impactSpeed: input.impactSpeed ?? 0,
        normal: input.normal ? copyVec(input.normal) : null,
        caneActive: input.caneActive ?? false,
        visionId: visionId === undefined || visionId === null ? null : String(visionId),
      };
      if (input.synthetic) event.synthetic = true;

      enqueue((store) => store.add(event));
      return event;
    },

    getEvents: getAllEvents,
    clear: clearEvents,
  };

  // Install on the world (cast: `audit` may not be declared on World yet, or may be a stub).
  try {
    (world as unknown as Record<string, unknown>).audit = api;
  } catch {
    Object.defineProperty(world, 'audit', { value: api, configurable: true, writable: true });
  }

  // 'caught': log at the player's position.
  if (typeof w.on === 'function') {
    w.on('caught', () => {
      api.log({ kind: 'caught', hit: 'entity' });
    });
  } else {
    console.warn("[audit] world.on is not available yet; 'caught' events will not be logged.");
  }

  // Report UI (M) and dev test (J). Dynamic import avoids a static log <-> report cycle.
  void import('./report')
    .then((m) => m.initReport(world))
    .catch((err) => console.warn('[audit] report UI failed to start:', err));

  return api;
}