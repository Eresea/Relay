import { describe, expect, it } from 'vitest';

import { currentSurface } from './surface';

describe('currentSurface', () => {
  it('honors an explicit surface', () => {
    expect(currentSurface('?surface=mobile', 'Windows')).toBe('mobile');
  });

  it('selects the mobile surface for Android without a query parameter', () => {
    expect(currentSurface('', 'Mozilla/5.0 Android 15')).toBe('mobile');
  });

  it('keeps desktop browsers on the main surface', () => {
    expect(currentSurface('', 'Mozilla/5.0 Windows NT 10.0')).toBe('main');
  });
});
