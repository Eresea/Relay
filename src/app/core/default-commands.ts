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
      id: 'relay.projects.open',
      title: 'Open projects',
      group: 'Project',
      icon: 'library',
      keywords: ['project', 'workspace', 'folder', 'github', 'sync'],
      run: () => tauri.runCoreCommand({ id: 'open_main' }),
    },
    {
      id: 'relay.runtime.open',
      title: 'Open Runtime',
      group: 'Project',
      icon: 'info',
      keywords: ['runtime', 'status', 'health', 'grafana', 'metrics', 'leaf'],
      run: () => tauri.runCoreCommand({ id: 'open_runtime' }),
    },
    {
      id: 'relay.agents.open',
      title: 'Agent threads',
      group: 'Agents',
      icon: 'bot',
      keywords: ['codex', 'conversation', 'session'],
      run: () => tauri.runCoreCommand({ id: 'open_agents' }),
    },
    {
      id: 'relay.theme.toggle',
      title: 'Toggle theme',
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
      group: 'Relay',
      icon: 'lock',
      keywords: ['password', 'generate', 'vault', 'security', 'account'],
      run: () => tauri.runCoreCommand({ id: 'open_vault' }),
    },
    {
      id: 'relay.github.open',
      title: 'GitHub',
      group: 'Relay',
      icon: 'inbox',
      keywords: ['github', 'pull request', 'pr', 'ci', 'notifications', 'connector'],
      run: () => tauri.runCoreCommand({ id: 'open_github' }),
    },
    {
      id: 'relay.app.reload',
      title: 'Reload interface',
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
