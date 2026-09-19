/**
 * Identity by hue.
 *
 * Seven hues, assigned by stable hash of an object's id so the same agent,
 * job or service is the same colour on every surface — palette row, HUD
 * notification, tray popover, table row. Hue means *which*; status means *how
 * it is going*. Never derive a hue from state.
 */
export const ENTITY_HUES = [
  'indigo',
  'violet',
  'cyan',
  'emerald',
  'amber',
  'orange',
  'rose',
] as const;

export type EntityHue = (typeof ENTITY_HUES)[number];

/** FNV-1a. Stable across runs and platforms, which `String.hashCode`-style
 * ad hoc sums are not. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hueFor(id: string): EntityHue {
  return ENTITY_HUES[hash(id) % ENTITY_HUES.length];
}

/** The CSS custom property the tile recipe reads. */
export function hueVar(hue: EntityHue): string {
  return `var(--entity-${hue})`;
}
