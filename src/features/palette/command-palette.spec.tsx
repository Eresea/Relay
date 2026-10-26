import { act, fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import type { Command } from '@/core/command';
import { CommandRegistry } from '@/core/command-registry';
import { inject } from '@/lib/inject';

import CommandPalette from './command-palette';

function command(id: string, title = id): Command {
  return { id, title, group: 'Test', run: () => undefined };
}

it('scrolls the active row into view when the selection moves past what is visible', () => {
  inject(CommandRegistry).register(...Array.from({ length: 30 }, (_, i) => command(`cmd-${i}`)));
  const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
  const { container } = render(<CommandPalette />);
  scrollIntoView.mockClear();

  act(() => {
    fireEvent.keyDown(container.querySelector('.omnibar')!, { key: 'ArrowDown' });
  });

  expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }));
  // It scrolled the row that is now active (index 1), not the one it left.
  expect((scrollIntoView.mock.contexts.at(-1) as HTMLElement).id).toBe('cmd-cmd-1');
});
