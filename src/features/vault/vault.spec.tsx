import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { provideBridge } from '@/test/bridge';

import Vault from './vault';

const hello = (enrolled: boolean, current = enrolled) => ({ available: true, enrolled, current });

function provideVault(overrides: Record<string, unknown> = {}) {
  let unlocked = false;
  return provideBridge({
    vaultStatus: vi.fn(() => Promise.resolve({ exists: true, unlocked })),
    vaultListEntries: vi.fn().mockResolvedValue([]),
    openCloudStatus: vi
      .fn()
      .mockResolvedValue({ connected: false, webdavUrl: null, username: null }),
    onEvent: vi.fn().mockResolvedValue(() => undefined),
    vaultPasskeyUnlock: vi.fn(() => {
      unlocked = true;
      return Promise.resolve();
    }),
    vaultPasskeyEnroll: vi.fn().mockResolvedValue(undefined),
    vaultPasskeyStatus: vi.fn().mockResolvedValue(hello(true)),
    ...overrides,
  });
}

it('unlocks with Windows Hello when it is set up for this vault', async () => {
  const bridge = provideVault();
  render(<Vault />);

  fireEvent.click(await screen.findByRole('button', { name: 'Unlock with Windows Hello' }));
  await waitFor(() => expect(bridge.vaultPasskeyUnlock).toHaveBeenCalledOnce());
  expect(await screen.findByRole('heading', { name: 'Windows Hello' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
});

it('says why Windows Hello stopped matching and offers to set it up again', async () => {
  provideVault({ vaultPasskeyStatus: vi.fn().mockResolvedValue(hello(true, false)) });
  render(<Vault />);

  expect(
    await screen.findByText(/stopped matching after the master password changed/),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Unlock with Windows Hello' })).toBeNull();
});

it('shows a Hello failure where the password error would be', async () => {
  provideVault({
    vaultPasskeyUnlock: vi.fn().mockRejectedValue('Windows Hello was cancelled'),
  });
  render(<Vault />);

  fireEvent.click(await screen.findByRole('button', { name: 'Unlock with Windows Hello' }));
  expect(await screen.findByText('Windows Hello was cancelled')).toBeTruthy();
});
