import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import type { ShortcutInfo } from '@/core/tauri';
import { provideBridge } from '@/test/bridge';

import { Shortcuts, acceleratorOf, keycaps } from './shortcuts';

const press = (
  key: string,
  code: string,
  mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {},
) => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

it('turns a key press into the core notation and back into keycaps', () => {
  expect(acceleratorOf(press('K', 'KeyK', { ctrlKey: true, shiftKey: true }))).toBe(
    'Ctrl+Shift+KeyK',
  );
  expect(acceleratorOf(press(' ', 'Space', { ctrlKey: true, altKey: true }))).toBe(
    'Ctrl+Alt+Space',
  );
  expect(acceleratorOf(press('Control', 'ControlLeft', { ctrlKey: true }))).toBeNull();
  expect(keycaps('Ctrl+Super+Digit1')).toEqual(['Ctrl', 'Win', '1']);
  expect(keycaps('Alt+Backquote')).toEqual(['Alt', 'Backquote']);
});

const palette: ShortcutInfo = {
  action: 'palette',
  label: 'Open the Omnibar',
  accelerator: 'Ctrl+Space',
  default: 'Ctrl+Space',
  status: 'active',
  message: null,
};
const attention: ShortcutInfo = {
  action: 'attention',
  label: 'Open the attention stack',
  accelerator: 'Ctrl+Alt+Space',
  default: 'Ctrl+Alt+Space',
  status: 'taken',
  message: 'Ctrl+Alt+Space is taken by another application. Choose another combination.',
};

it('says a taken shortcut is taken and rebinds it from a recorded press', async () => {
  const bridge = provideBridge({
    shortcutsList: vi.fn().mockResolvedValue([palette, attention]),
    shortcutsSet: vi
      .fn()
      .mockRejectedValueOnce('Ctrl+Space already does “open the omnibar”')
      .mockResolvedValueOnce({
        ...attention,
        accelerator: 'Ctrl+Shift+KeyK',
        status: 'active',
        message: null,
      }),
    shortcutsReset: vi.fn().mockResolvedValue(attention),
  });
  render(<Shortcuts />);

  expect((await screen.findByRole('alert')).textContent).toContain('taken by another application');
  const keys = screen.getByRole('button', { name: /Open the attention stack: Ctrl\+Alt\+Space/ });

  // Escape leaves recording without changing anything.
  fireEvent.click(keys);
  expect(keys.textContent).toBe('Recording…');
  fireEvent.keyDown(keys, { key: 'Escape', code: 'Escape' });
  expect(bridge.shortcutsSet).not.toHaveBeenCalled();

  // A combination the core refuses shows its reason.
  fireEvent.click(keys);
  fireEvent.keyDown(keys, { key: ' ', code: 'Space', ctrlKey: true });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('already does'));

  fireEvent.click(keys);
  fireEvent.keyDown(keys, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
  fireEvent.keyDown(keys, { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true });
  await waitFor(() =>
    expect(bridge.shortcutsSet).toHaveBeenLastCalledWith('attention', 'Ctrl+Shift+KeyK'),
  );
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(screen.getByRole('button', { name: /Ctrl\+Shift\+KeyK/ })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Reset to Ctrl+Alt+Space' }));
  await waitFor(() => expect(bridge.shortcutsReset).toHaveBeenCalledWith('attention'));
});
