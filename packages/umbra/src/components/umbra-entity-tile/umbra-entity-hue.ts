/**
 * Hue identifies an object, while status says how it is going. Derive it from a
 * stable identity so the same object keeps its hue across surfaces.
 */
export const ENTITY_HUES = ['indigo', 'violet', 'cyan', 'emerald', 'amber', 'orange', 'rose'] as const;

export type UmbraEntityHue = (typeof ENTITY_HUES)[number];

export function hueFor(key = ''): UmbraEntityHue {
  let hash = 0;
  for (let index = 0; index < key.length; index++) {
    hash = (hash * 31 + key.charCodeAt(index)) % 9973;
  }
  return ENTITY_HUES[hash % ENTITY_HUES.length];
}
