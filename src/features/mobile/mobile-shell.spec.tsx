import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import type { NexusAuthStatus } from '@/core/tauri';
import { provideBridge } from '@/test/bridge';

import Mobile from './mobile';

const signedOut: NexusAuthStatus = {
  connected: false,
  userId: null,
  email: null,
  displayName: null,
};

function renderMobile(status = signedOut) {
  const bridge = provideBridge({
    available: true,
    getSetting: vi.fn().mockResolvedValue(false),
    setSetting: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn().mockResolvedValue(() => undefined),
    vaultStatus: vi.fn().mockResolvedValue({ exists: false, unlocked: false }),
    githubStatus: vi.fn().mockResolvedValue({ connected: false }),
    gmailStatus: vi.fn().mockResolvedValue({ connected: false }),
    mobileUpdateCheck: vi.fn().mockResolvedValue(null),
    onNexusAuth: vi.fn().mockResolvedValue(() => undefined),
    nexusAuthStatus: vi.fn().mockResolvedValue(status),
    nexusAuthStart: vi.fn().mockResolvedValue(undefined),
  });
  const { container } = render(<Mobile />);
  return { bridge, container };
}

it('offers sign-in from the rail while signed out', async () => {
  const { bridge } = renderMobile();
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation', hidden: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Nexus' }));
  await waitFor(() => expect(bridge.nexusAuthStart).toHaveBeenCalledOnce());
});

it('shows who is signed in instead of the sign-in button', async () => {
  renderMobile({ ...signedOut, connected: true, displayName: 'Nils' });
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation', hidden: true }));
  expect(await screen.findByText('Nils')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Sign in with Nexus' })).toBeNull();
});

it('pins Settings below the module list until it is searched for', async () => {
  const { container } = renderMobile();
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation', hidden: true }));
  const list = container.querySelector('#mobile-module-results')!;
  const pinned = container.querySelector('.rail-settings')!;
  await waitFor(() => expect(pinned.textContent).toContain('Settings'));
  expect(list.textContent).not.toContain('Settings');

  fireEvent.change(screen.getByRole('combobox', { name: 'Find a module' }), {
    target: { value: 'sett' },
  });
  await waitFor(() => expect(list.textContent).toContain('Settings'));
});

it('only opens the keyboard when asked to search', async () => {
  const { container } = renderMobile();
  const rail = container.querySelector('#mobile-rail')!;
  const search = () => container.querySelector<HTMLInputElement>('.rail-search input')!;
  const slide = () => {
    const end = new Event('transitionend', { bubbles: true });
    Object.defineProperty(end, 'propertyName', { value: 'transform' });
    rail.dispatchEvent(end);
  };

  fireEvent.click(screen.getByRole('button', { name: 'Open navigation', hidden: true }));
  await waitFor(() => expect(document.activeElement).toBe(container.querySelector('.rail-close')));
  slide();
  expect(document.activeElement).not.toBe(search());

  fireEvent.click(container.querySelector('.rail-close')!);
  fireEvent.click(screen.getByRole('button', { name: 'Find a module', hidden: true }));
  slide();
  await waitFor(() => expect(document.activeElement).toBe(search()));
});
