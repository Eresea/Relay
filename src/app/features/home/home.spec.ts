import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';

import { TauriBridge, type NexusAuthStatus } from '@core/tauri';
import { ThemeService } from '@core/theme';
import { AppPopover, PopoverContent, PopoverTrigger } from '@shared/app-popover';
import { Icon } from '@shared/icon';

import { Home } from './home';

afterEach(() => TestBed.resetTestingModule());

it('manages Nexus sign-in from the avatar below Settings and reports failures', async () => {
  let onAuth: (status: NexusAuthStatus) => void = () => undefined;
  const disconnected: NexusAuthStatus = {
    connected: false,
    userId: null,
    email: null,
    displayName: null,
  };
  const bridge = {
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
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: TauriBridge, useValue: bridge },
      { provide: ThemeService, useValue: { theme: signal('dark') } },
    ],
  });
  TestBed.overrideComponent(Home, {
    set: {
      imports: [AppPopover, PopoverContent, PopoverTrigger, Icon],
      schemas: [NO_ERRORS_SCHEMA],
    },
  });
  const fixture = TestBed.createComponent(Home);
  fixture.detectChanges();
  await fixture.whenStable();
  const host = fixture.nativeElement as HTMLElement;
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Nexus account"]')!;
  expect(host.querySelector('.rail-bottom')?.children[0].getAttribute('aria-label')).toBe(
    'Settings',
  );
  expect(trigger.querySelector('.avatar')?.textContent?.trim()).toBe('N');

  const item = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) =>
      button.textContent?.includes(label),
    )!;

  trigger.click();
  fixture.detectChanges();
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  item('Sign in with Nexus').click();
  await fixture.whenStable();
  expect(bridge.nexusAuthStart).toHaveBeenCalledOnce();
  fixture.detectChanges();
  expect(host.textContent).toContain('Waiting for sign-in');

  onAuth({ connected: true, userId: 'user', email: 'alex@example.com', displayName: 'Alex' });
  fixture.detectChanges();
  expect(trigger.querySelector('.avatar')?.textContent?.trim()).toBe('A');
  expect(host.querySelector('.account-menu')?.textContent).toContain('alex@example.com');
  item('Sign out everywhere').click();
  await fixture.whenStable();
  expect(bridge.nexusAuthLogout).toHaveBeenLastCalledWith(true);

  // The session was revoked elsewhere: back to signed out, no error shown.
  onAuth({ connected: true, userId: 'user', email: 'alex@example.com', displayName: 'Alex' });
  fixture.detectChanges();
  onAuth(disconnected);
  fixture.detectChanges();
  expect(host.textContent).toContain('Sign in with Nexus');
  expect(host.querySelector('[role="alert"]')).toBeNull();

  bridge.nexusAuthStart.mockRejectedValueOnce('Could not open browser');
  item('Sign in with Nexus').click();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not open browser');
  expect(item('Sign in with Nexus').disabled).toBe(false);

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  fixture.detectChanges();
  expect(host.querySelector('.account-menu')).toBeNull();
});
