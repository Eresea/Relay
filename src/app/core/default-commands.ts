import { inject } from '@angular/core';

import type { Command } from './command';
import { CommandRegistry } from './command-registry';
import { TauriBridge } from './tauri';
import { ThemeService } from './theme';

/**
 * The commands Relay ships with. Feature areas register their own on init;
 * this is only the floor, so that a fresh install has a working palette.
 */
export function registerDefaultCommands(): () => void {
  const registry = inject(CommandRegistry);
  const theme = inject(ThemeService);
  const tauri = inject(TauriBridge);

  const commands: Command[] = [
    {
      id: 'relay.theme.toggle',
      title: 'Toggle theme',
      hint: 'Switch between dark and light',
      group: 'Appearance',
      icon: 'sun',
      keywords: ['dark', 'light', 'appearance'],
      run: () => theme.toggle(),
    },
    {
      id: 'relay.window.settings',
      title: 'Open settings',
      group: 'Relay',
      icon: 'settings',
      run: () => tauri.runCoreCommand('open_settings'),
    },
    {
      id: 'relay.app.reload',
      title: 'Reload interface',
      hint: 'Rebuild the webview without restarting Relay',
      group: 'Relay',
      icon: 'loader-circle',
      keywords: ['refresh', 'restart'],
      run: () => location.reload(),
    },
    {
      id: 'relay.app.quit',
      title: 'Quit Relay',
      group: 'Relay',
      icon: 'circle-alert',
      run: () => tauri.runCoreCommand('quit'),
    },
  ];

  return registry.register(...commands);
}
