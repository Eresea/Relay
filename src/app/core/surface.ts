/**
 * Relay renders several surfaces from one bundle. Which one a webview shows is
 * decided by its Tauri window label, passed through as a query parameter so the
 * choice is also testable in a plain browser (`?surface=palette`).
 */
export type Surface = 'palette' | 'hud' | 'main';

const SURFACES: readonly Surface[] = ['palette', 'hud', 'main'];

export function currentSurface(search: string = location.search): Surface {
  const requested = new URLSearchParams(search).get('surface');
  return SURFACES.includes(requested as Surface) ? (requested as Surface) : 'main';
}

/** Surfaces that float over the desktop, and so take the glass tier. */
export function isOverlaySurface(surface: Surface): boolean {
  return surface === 'palette' || surface === 'hud';
}
