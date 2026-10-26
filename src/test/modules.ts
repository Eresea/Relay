import { vi } from 'vitest';

import type { ModuleInfo, ModuleManifest } from '@/core/modules';

type Fixture = Pick<ModuleManifest, 'id' | 'name' | 'icon' | 'hue'> & Partial<ModuleManifest>;

function module(fixture: Fixture): ModuleInfo {
  return {
    summary: '',
    description: '',
    kind: 'native',
    source: 'built-in',
    core: false,
    surface: null,
    commands: [],
    items: false,
    signals: false,
    needs: [],
    enabled: true,
    ...fixture,
  };
}

const tab = (label: string, icon: string, rail = true) => ({ label, icon, rail });

/** A slice of the core's built-in modules (src-tauri/src/modules.rs), for tests. */
export const MODULES: readonly ModuleInfo[] = [
  module({
    id: 'today',
    name: 'Today',
    icon: 'house',
    hue: 'relay',
    core: true,
    surface: tab('Today', 'house'),
  }),
  module({
    id: 'linear',
    name: 'Linear',
    icon: 'inbox',
    hue: 'linear',
    surface: tab('My work', 'inbox'),
  }),
  module({
    id: 'codex',
    name: 'Codex',
    icon: 'sparkles',
    hue: 'agents',
    surface: tab('Codex', 'sparkles'),
    commands: ['relay.agents.open'],
    needs: [{ permission: 'shell', scope: 'the Codex CLI' }],
  }),
  module({
    id: 'claude',
    name: 'Claude Code',
    icon: 'bot',
    hue: 'agents',
    surface: tab('Claude', 'bot'),
    commands: ['relay.claude.open'],
  }),
  module({
    id: 'projects',
    name: 'Projects',
    icon: 'folder',
    hue: 'files',
    surface: tab('Projects', 'folder'),
  }),
  module({
    id: 'vault',
    name: 'Vault',
    icon: 'lock',
    hue: 'vault',
    surface: tab('Vault', 'lock'),
    commands: ['relay.vault.open'],
  }),
  module({
    id: 'runtime',
    name: 'Runtime',
    icon: 'activity',
    hue: 'runtime',
    surface: tab('Runtime', 'activity'),
  }),
  module({ id: 'github', name: 'GitHub', icon: 'git-pull-request', hue: 'github', items: true }),
  module({ id: 'gmail', name: 'Mail', icon: 'mail', hue: 'mail', items: true }),
  module({
    id: 'modules',
    name: 'Modules',
    icon: 'blocks',
    hue: 'relay',
    core: true,
    surface: tab('Modules', 'blocks', false),
  }),
  module({
    id: 'settings',
    name: 'Settings',
    icon: 'settings',
    hue: 'relay',
    core: true,
    surface: tab('Settings', 'settings', false),
  }),
  module({
    id: 'account',
    name: 'Nexus',
    icon: 'user',
    hue: 'relay',
    core: true,
    surface: tab('Account', 'user', false),
  }),
];

/** Bridge overrides that behave like the core's registry: it keeps what was turned off. */
export function fakeModuleCore(off: readonly string[] = []) {
  const state = new Set(off);
  return {
    modulesList: vi.fn(() =>
      Promise.resolve(MODULES.map((m) => ({ ...m, enabled: m.core || !state.has(m.id) }))),
    ),
    modulesSetEnabled: vi.fn((id: string, enabled: boolean) => {
      if (enabled) state.delete(id);
      else state.add(id);
      return Promise.resolve();
    }),
  };
}
