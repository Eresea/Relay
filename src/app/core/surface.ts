/**
 * Relay renders several surfaces from one bundle. Which one a webview shows is
 * decided by a query parameter for desktop overlay windows. Android leaves the
 * query empty and selects the mobile surface from its WebView user agent, so
 * the same frontend bundle can serve both app shapes.
 */
export type Surface = 'palette' | 'hud' | 'main' | 'mobile';

const SURFACES: readonly Surface[] = ['palette', 'hud', 'main', 'mobile'];

export function currentSurface(
  search: string = location.search,
  userAgent: string = navigator.userAgent,
): Surface {
  const requested = new URLSearchParams(search).get('surface');
  if (SURFACES.includes(requested as Surface)) return requested as Surface;
  return /Android/i.test(userAgent) ? 'mobile' : 'main';
}

/** Surfaces that float over the desktop, and so take the glass tier. */
export function isOverlaySurface(surface: Surface): boolean {
  return surface === 'palette' || surface === 'hud';
}
