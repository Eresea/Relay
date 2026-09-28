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
    nexusAuthGoogleStart: vi.fn().mockResolvedValue(undefined),
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

  trigger.click();
  fixture.detectChanges();
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  host.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
  fixture.detectChanges();
  host.querySelector<HTMLButtonElement>('.account-dialog-google')!.click();
  await fixture.whenStable();
  expect(bridge.nexusAuthGoogleStart).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('Waiting for Google…');

  onAuth({ connected: true, userId: 'user', email: 'alex@example.com', displayName: 'Alex' });
  fixture.detectChanges();
  expect(trigger.querySelector('.avatar')?.textContent?.trim()).toBe('A');
  trigger.click();
  fixture.detectChanges();
  expect(host.querySelector('.account-menu')?.textContent).toContain('alex@example.com');
  (host.querySelectorAll('[role="menuitem"]')[1] as HTMLButtonElement).click();
  await fixture.whenStable();
  expect(bridge.nexusAuthLogout).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('Connect through Nexus');

  bridge.nexusAuthGoogleStart.mockRejectedValueOnce('Could not open browser');
  host.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
  fixture.detectChanges();
  host.querySelector<HTMLButtonElement>('.account-dialog-google')!.click();
  await fixture.whenStable();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not open browser');
  expect(host.querySelector<HTMLButtonElement>('.account-dialog-google')!.disabled).toBe(false);

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  fixture.detectChanges();
  expect(host.querySelector('.account-menu')).toBeNull();
});
