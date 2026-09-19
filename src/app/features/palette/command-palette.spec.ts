import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Command } from '@core/command';
import { CommandRegistry } from '@core/command-registry';

import { CommandPalette } from './command-palette';

function command(id: string, title = id): Command {
  return { id, title, group: 'Test', run: () => undefined };
}

describe('CommandPalette', () => {
  let registry: CommandRegistry;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // jsdom does not implement scrollIntoView at all.
    scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof HTMLElement.prototype.scrollIntoView;

    TestBed.configureTestingModule({});
    registry = TestBed.inject(CommandRegistry);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('scrolls the active row into view when the selection moves past what is visible', async () => {
    registry.register(...Array.from({ length: 30 }, (_, i) => command(`cmd-${i}`)));

    const fixture = TestBed.createComponent(CommandPalette);
    fixture.detectChanges();
    await fixture.whenStable();

    scrollIntoView.mockClear();

    const host = fixture.nativeElement as HTMLElement;
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }));

    // It scrolled the row that is now active (index 1), not the one it left.
    const scrolledRow = scrollIntoView.mock.contexts[0] as HTMLElement;
    expect(scrolledRow.id).toBe('cmd-cmd-1');
  });
});
