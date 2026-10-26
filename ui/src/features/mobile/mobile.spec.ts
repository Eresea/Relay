import { describe, expect, it } from 'vitest';

import { mobileSwipeAction } from './mobile';

describe('mobileSwipeAction', () => {
  it('opens the rail on a decisive rightward swipe', () => {
    expect(mobileSwipeAction(80, 10)).toBe('open-rail');
  });

  it('marks a notification read on a decisive leftward swipe', () => {
    expect(mobileSwipeAction(-80, 10)).toBe('mark-read');
  });

  it('ignores short and mostly vertical movement', () => {
    expect(mobileSwipeAction(40, 4)).toBeNull();
    expect(mobileSwipeAction(-100, 120)).toBeNull();
  });
});
