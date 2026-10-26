import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import { AppPopover, PopoverContent, PopoverTrigger } from './app-popover';
import { IconPicker } from './icon-picker';

it('toggles its content and closes on Escape', () => {
  render(
    <AppPopover>
      <PopoverTrigger>
        <button type="button">Open</button>
      </PopoverTrigger>
      <PopoverContent>Content</PopoverContent>
    </AppPopover>,
  );
  expect(screen.queryByText('Content')).toBeNull();

  fireEvent.click(screen.getByText('Open'));
  expect(screen.getByText('Content')).toBeTruthy();

  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  expect(screen.queryByText('Content')).toBeNull();
});

it('filters the icon catalog and reports the selected icon', () => {
  let selected = '';
  render(<IconPicker onValueChange={(icon) => (selected = icon)} />);

  fireEvent.click(screen.getByRole('button', { name: 'Choose project icon' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'star' } });

  const options = screen.getAllByRole('option');
  expect(options).toHaveLength(1);
  expect(options[0]?.getAttribute('aria-label')).toBe('Star');

  fireEvent.click(options[0]);
  expect(selected).toBe('star');
});
