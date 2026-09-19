import { describe, expect, it } from 'vitest';

import { ENTITY_HUES, hueFor, hueVar } from './entity-hue';

describe('hueFor', () => {
  it('always returns one of the seven hues', () => {
    for (let i = 0; i < 500; i++) {
      expect(ENTITY_HUES).toContain(hueFor(`agent-${i}`));
    }
  });

  it('is stable for the same id', () => {
    expect(hueFor('agent-alpha')).toBe(hueFor('agent-alpha'));
  });

  it('spreads across the whole ramp', () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => hueFor(`job-${i}`)));
    expect(seen.size).toBe(ENTITY_HUES.length);
  });

  it('distinguishes ids that differ only by order', () => {
    expect(hueFor('ab')).not.toBe(hueFor('ba'));
  });
});

describe('hueVar', () => {
  it('names the custom property the tile recipe reads', () => {
    expect(hueVar('cyan')).toBe('var(--entity-cyan)');
  });
});
