import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import type { NexusAuthStatus } from '@/core/tauri';
import { ThemeService } from '@/core/theme';
import { NotificationCenter } from '@/core/notification-center';
import { inject, provide } from '@/lib/inject';
import { signal } from '@/lib/signals';
import { provideBridge } from '@/test/bridge';
import { fakeModuleCore } from '@/test/modules';

import Home from './home';

it('manages Nexus sign-in from the avatar below Settings and reports failures', async () => {
  let onAuth: (status: NexusAuthStatus) => void = () => undefined;
  const disconnected: NexusAuthStatus = {
    connected: false,
    userId: null,
    email: null,
    displayName: null,
  };
  const bridge = provideBridge({
    ...fakeModuleCore(),
    available: true,
    getSetting: vi.fn().mockResolvedValue(false),
    isWindowMaximized: vi.fn().mockResolvedValue(false),
    onWindowResized: vi.fn().mockResolvedValue(() => undefined),
    onEvent: vi.fn().mockResolvedValue(() => undefined),
    onNexusAuth: vi.fn((handler: typeof onAuth) => {
      onAuth = handler;
      return Promise.resolve(() => undefined);
    }),
    nexusAuthStatus: vi.fn().mockResolvedValue(disconnected),
    nexusAuthStart: vi.fn().mockResolvedValue(undefined),
    nexusAuthLogout: vi.fn().mockResolvedValue(undefined),
  });
  provide(ThemeService, {
    theme: signal('dark'),
    toggle: () => undefined,
  } as unknown as ThemeService);

  const { container } = render(<Home />);
  const trigger = screen.getByRole('button', { name: 'Nexus account' });
  expect(container.querySelector('.rail-bottom')?.children[1]?.getAttribute('aria-label')).toBe(
    'Settings',
  );
  expect(trigger.querySelector('.avatar')?.textContent?.trim()).toBe('N');
  const item = (label: string) =>
    screen.getAllByRole('menuitem').find((button) => button.textContent?.includes(label))!;

  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(item('Sign in with Nexus'));
  await waitFor(() => expect(bridge.nexusAuthStart).toHaveBeenCalledOnce());
  await waitFor(() => expect(container.textContent).toContain('Waiting for sign-in'));

  act(() =>
    onAuth({ connected: true, userId: 'user', email: 'alex@example.com', displayName: 'Alex' }),
  );
  expect(trigger.querySelector('.avatar')?.textContent?.trim()).toBe('A');
  expect(container.querySelector('.account-menu')?.textContent).toContain('alex@example.com');
  fireEvent.click(item('Sign out everywhere'));
  await waitFor(() => expect(bridge.nexusAuthLogout).toHaveBeenLastCalledWith(true));

  // The session was revoked elsewhere: back to signed out, no error shown.
  act(() =>
    onAuth({ connected: true, userId: 'user', email: 'alex@example.com', displayName: 'Alex' }),
  );
  act(() => onAuth(disconnected));
  expect(container.textContent).toContain('Sign in with Nexus');
  expect(screen.queryByRole('alert')).toBeNull();

  bridge.nexusAuthStart.mockRejectedValueOnce('Could not open browser');
  fireEvent.click(item('Sign in with Nexus'));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Could not open browser'),
  );
  expect((item('Sign in with Nexus') as HTMLButtonElement).disabled).toBe(false);

  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  expect(container.querySelector('.account-menu')).toBeNull();
});

it('opens views as tabs and closes them like browser tabs', async () => {
  provideBridge({ ...fakeModuleCore(), available: false });
  provide(ThemeService, {
    theme: signal('dark'),
    toggle: () => undefined,
  } as unknown as ThemeService);
  render(<Home />);
  const tabs = () => screen.getAllByRole('tab').map((tab) => tab.textContent);
  const selected = () => screen.getByRole('tab', { selected: true }).textContent;

  fireEvent.click(await screen.findByRole('button', { name: 'Vault' }));
  fireEvent.click(screen.getByRole('button', { name: 'Runtime' }));
  expect(tabs()).toEqual(['Today', 'Vault', 'Runtime']);
  expect(selected()).toBe('Runtime');

  // Middle click closes the tab under the pointer, not the selected one.
  const vault = screen.getByRole('tab', { name: 'Vault' }).parentElement!;
  fireEvent.mouseDown(vault, { button: 1 });
  fireEvent(vault, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(tabs()).toEqual(['Today', 'Runtime']);

  fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
  expect(selected()).toBe('Today');
  fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true });
  expect(selected()).toBe('Runtime');

  // Ctrl+W closes the selected tab; Today is pinned and stays.
  fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
  fireEvent.keyDown(window, { key: 'w', ctrlKey: true });
  expect(tabs()).toEqual(['Today']);
  expect(selected()).toBe('Today');
});

it('builds the rail from the core registry and drops a module turned off on the Modules screen', async () => {
  const core = fakeModuleCore();
  provideBridge({ ...core, available: false });
  provide(ThemeService, {
    theme: signal('dark'),
    toggle: () => undefined,
  } as unknown as ThemeService);
  render(<Home />);
  const rail = () =>
    [...document.querySelectorAll('.rail-top .rail-item')].map((b) => b.getAttribute('aria-label'));
  await waitFor(() =>
    expect(rail()).toEqual(['Today', 'My work', 'Agents', 'Projects', 'Vault', 'Runtime']),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Vault' }));
  fireEvent.click(screen.getByRole('button', { name: 'Modules' }));
  // The Modules screen loads lazily; a cold first run can take over a second.
  fireEvent.click(await screen.findByRole('switch', { name: 'Vault on' }, { timeout: 5000 }));

  expect(core.modulesSetEnabled).toHaveBeenCalledWith('vault', false);
  await waitFor(() => expect(rail()).not.toContain('Vault'));
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Today', 'Modules']);
  expect(screen.getByRole('switch', { name: 'Vault on' })).toHaveProperty('checked', false);
});

it('marks a tab whose module needs you, reorders tabs, and opens Today from the counts', async () => {
  provideBridge({ ...fakeModuleCore(), available: false });
  provide(ThemeService, {
    theme: signal('dark'),
    toggle: () => undefined,
  } as unknown as ThemeService);
  inject(NotificationCenter).handle({
    type: 'notification',
    notificationId: 'ask',
    jobId: 'ask',
    hueSource: 'claude',
    title: 'Claude · add a health check',
    detail: 'Run `npm test`',
    status: 'waiting',
  });
  render(<Home />);
  const tabs = () =>
    screen.getAllByRole('tab').map((tab) => ({
      label: tab.querySelector('.tab-label')?.textContent,
      waiting: !!tab.querySelector('.tab-dot'),
    }));

  fireEvent.click(await screen.findByRole('button', { name: 'Agents' }));
  fireEvent.click(screen.getByRole('button', { name: 'Vault' }));
  expect(tabs()).toEqual([
    { label: 'Today', waiting: true },
    { label: 'Agents', waiting: true },
    { label: 'Vault', waiting: false },
  ]);

  // Drag Vault onto Agents; a drop on Today is refused, so it stays first.
  const tab = (label: string) =>
    screen.getAllByRole('tab').find((el) => el.textContent?.startsWith(label))!.parentElement!;
  // jsdom's drag events carry no DataTransfer; a browser's always do.
  const dataTransfer = { effectAllowed: 'none' };
  fireEvent.dragStart(tab('Vault'), { dataTransfer });
  fireEvent.dragOver(tab('Agents'));
  fireEvent.drop(tab('Agents'));
  fireEvent.dragEnd(tab('Vault'));
  fireEvent.dragStart(tab('Agents'), { dataTransfer });
  fireEvent.drop(tab('Today'));
  fireEvent.dragEnd(tab('Agents'));
  expect(tabs().map((t) => t.label)).toEqual(['Today', 'Vault', 'Agents']);

  fireEvent.click(screen.getByRole('button', { name: /1 need you, 0 running. Open Today/ }));
  expect(screen.getByRole('tab', { selected: true }).textContent).toContain('Today');
});
