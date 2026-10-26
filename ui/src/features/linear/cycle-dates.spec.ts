import { describe, expect, it } from 'vitest';

import { cycleDateInTimezone, cycleDateToIso } from './cycle-dates';

describe('Linear cycle dates', () => {
  it('shows the date in the team timezone', () => {
    expect(cycleDateInTimezone('2026-09-27T01:00:00.000Z', 'America/Los_Angeles')).toBe(
      '2026-09-26',
    );
  });

  it('converts team midnight across daylight-saving offsets', () => {
    expect(cycleDateToIso('2026-03-08', 'America/Los_Angeles')).toBe('2026-03-08T08:00:00.000Z');
    expect(cycleDateToIso('2026-03-09', 'America/Los_Angeles')).toBe('2026-03-09T07:00:00.000Z');
  });
});
