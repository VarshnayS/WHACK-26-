/**
 * src/world/tactileConfig.ts: sizes, spacings and offsets for tactile paving (src/world/tactile.ts)
 * Owner: TACTILE-WORLD (feat/tactile-world)
 *
 * Plain constants only. Metres unless stated. Real UK paving (DfT "Guidance on the use of tactile
 * paving surfaces") is 400 mm slabs with ~5 mm domes / bars; the relief here is exaggerated a little
 * so the sonar grid has something to ride over.
 */

// --- blister (crossings) -------------------------------------------------------------------------

/** Blister strip size along the kerb (across the walking direction). */
export const BLISTER_WIDTH = 2.4;
/** Blister strip size away from the kerb (along the walking direction, across the road). 0.8–1.2 m. */
export const BLISTER_DEPTH = 1.0;
/** Distance between dome centres. */
export const BLISTER_DOME_PITCH = 0.1;
/** Dome base radius. */
export const BLISTER_DOME_RADIUS = 0.03;
/** Dome height above the plate. */
export const BLISTER_DOME_HEIGHT = 0.012;
/** Two crossings of the same road closer than this are merged into one (m along the road). */
export const BLISTER_MERGE_DIST = 4;
/**
 * A footway that meets a road at less than this angle (degrees) runs along it (a pavement joining
 * the road), not across it: no crossing there.
 */
export const CROSSING_MIN_ANGLE_DEG = 35;

// --- guidance (pavements) ------------------------------------------------------------------------

/** Guidance strip width (across the walking direction). */
export const GUIDANCE_WIDTH = 0.4;
/** Distance between guidance segment centres along the path. */
export const GUIDANCE_SPACING = 0.6;
/** Length of each guidance segment (a little under the spacing, so the joints show). */
export const GUIDANCE_DEPTH = 0.56;
/** Number of raised bars per segment (they run along the walking direction). */
export const GUIDANCE_BARS = 4;
/** Width and height of one bar. */
export const GUIDANCE_BAR_WIDTH = 0.04;
export const GUIDANCE_BAR_HEIGHT = 0.012;
/** A new guidance segment closer than this to an existing one is dropped (overlapping paths). */
export const GUIDANCE_MIN_GAP = 0.35;

/** OSM highway tags that get guidance strips along them (steps, tracks etc. don't). */
export const GUIDANCE_HIGHWAYS: readonly string[] = ['footway', 'pedestrian', 'path', 'cycleway'];

// --- roads ---------------------------------------------------------------------------------------

/** Estimated half-width of the carriageway by OSM highway tag (OSM data here has no width tags). */
export const ROAD_HALF_WIDTH: Readonly<Record<string, number>> = {
  primary: 5,
  secondary: 4.5,
  tertiary: 4,
  unclassified: 3.5,
  residential: 3,
  service: 2.5,
};
/** Half-width for any other road tag. */
export const ROAD_HALF_WIDTH_DEFAULT = 3;
/** Guidance along a road without a footway runs this far beyond the estimated road edge. */
export const ROAD_GUIDANCE_OFFSET = 1;
/**
 * A road side counts as "has a footway" when a roughly parallel footway runs within this distance
 * of the road edge (then the footway gets the guidance instead).
 */
export const ROAD_FOOTWAY_SEARCH = 8;
/** "Roughly parallel": footway and road directions within this many degrees. */
export const ROAD_FOOTWAY_PARALLEL_DEG = 30;
/** Guidance is never placed on a carriageway: keep this far outside every estimated road edge. */
export const ROAD_CLEARANCE = 0.3;

// --- placement / rendering -----------------------------------------------------------------------

/** Strips whose footprint pokes outside the play corridor by more than this are dropped. */
export const CORRIDOR_MARGIN = 0;
/** Plate thickness; its top sits this far above the sampled ground (flush, without z-fighting). */
export const PLATE_THICKNESS = 0.01;
export const GROUND_LIFT = 0.012;
/**
 * After the grid snap, each strip's height is refined with one downward ray against the tiles (the
 * 2 m ground grid smooths over kerbs and ramps). The ray covers grid height +REFINE_UP to
 * -REFINE_DOWN; the hit closest to the grid height wins (so a bench or hedge above is ignored).
 */
export const REFINE_UP = 1;
export const REFINE_DOWN = 1;
/** CPU time per frame spent on refinement rays (ms). */
export const REFINE_BUDGET_MS = 2;
/** Object-space grid spacing on the paving (finer than the street grid so the relief reads). */
export const TACTILE_GRID_SIZE = 0.1;
/** Cell size of the spatial grid behind world.tactile.query(). */
export const QUERY_CELL = 2;

// --- toggle --------------------------------------------------------------------------------------

/** Key that toggles tactile paving mid-run. */
export const TOGGLE_KEY = 'KeyK';
/** How long the "Tactile paving: ON/OFF" message stays up (ms). */
export const TOGGLE_MESSAGE_MS = 1500;
