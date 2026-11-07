/**
 * src/game/settings.ts: player-chosen game options (set on the main menu, read by the game flow)
 *
 * Plain state + a change callback, no imports from the rest of the project, so the menu (HUD) and
 * src/game/flow.ts can both use it without an import cycle. Saved per browser in localStorage.
 */

const KEY = 'blindsim.entityEnabled';

function load(): boolean {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v !== null) return v === '1';
  } catch {
    /* storage blocked: use the default */
  }
  return true; // default: the entity is on (the game as it was before this option existed)
}

export const settings = {
  /** "Enable Entity (Hard Mode)": false = the entity never spawns / stays inactive. */
  entityEnabled: load(),
};

const listeners = new Set<() => void>();

export function setEntityEnabledSetting(value: boolean): void {
  if (settings.entityEnabled === value) return;
  settings.entityEnabled = value;
  try {
    window.localStorage.setItem(KEY, value ? '1' : '0');
  } catch {
    /* storage blocked */
  }
  for (const fn of listeners) fn();
}

/** Called whenever a setting changes. Returns an unsubscribe function. */
export function onSettingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}