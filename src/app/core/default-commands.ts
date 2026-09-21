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
      id: 'relay.project.open',
      title: 'Open current project',
      hint: 'Open the saved project folder',
      group: 'Project',
      icon: 'folder',
      keywords: ['project', 'workspace', 'folder', 'context'],
      run: async () => {
        const project = await tauri.getProjectContext();
        if (project) await tauri.openPath(project.path);
        else await tauri.runCoreCommand({ id: 'open_main' });
      },
    },
    {
      id: 'relay.project.set',
      title: 'Set current project',
      hint: 'Save a project folder path',
      group: 'Project',
      icon: 'folder',
      keywords: ['project', 'workspace', 'folder', 'context'],
      run: () => tauri.runCoreCommand({ id: 'open_main' }),
    },
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
      run: () => tauri.runCoreCommand({ id: 'open_settings' }),
    },
    {
      id: 'relay.vault.open',
      title: 'Password vault',
      hint: 'Generate and store passwords',
      group: 'Relay',
      icon: 'lock',
      keywords: ['password', 'generate', 'vault', 'security', 'account'],
      run: () => tauri.runCoreCommand({ id: 'open_vault' }),
    },
    {
      id: 'relay.github.open',
      title: 'GitHub',
      hint: 'Connect an account and manage notification rules',
      group: 'Relay',
      icon: 'inbox',
      keywords: ['github', 'pull request', 'pr', 'ci', 'notifications', 'connector'],
      run: () => tauri.runCoreCommand({ id: 'open_github' }),
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
      run: () => tauri.runCoreCommand({ id: 'quit' }),
    },
  ];

  return registry.register(...commands);
}
