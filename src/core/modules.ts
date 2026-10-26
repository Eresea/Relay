import { computed, signal } from '@/lib/signals';
import { inject } from '@/lib/inject';

import type { ModuleHue } from './entity-hue';
import { TauriBridge } from './tauri';

/** What a module may touch. Declared up front in its manifest, never requested at runtime. */
export type Permission = 'shell' | 'files' | 'network' | 'mail' | 'vault' | 'agents';

export const PERMISSIONS: Readonly<Record<Permission, string>> = {
  shell: 'Run programs',
  files: 'Read and write files',
  network: 'Reach the network',
  mail: 'Read and send mail',
  vault: 'Read the vault',
  agents: 'Agents may drive it',
};

export interface Need {
  readonly permission: Permission;
  /** Where the permission applies: "workspaces", "api.github.com". */
  readonly scope: string;
}

/**
 * A module's contract with the shell: what it gives (commands, Today items,
 * a surface, attention signals) and what it needs. Relay draws the rest.
 */
export interface ModuleManifest {
  readonly id: string;
  readonly name: string;
  /** One line under the name: who provides it, what it is. */
  readonly summary: string;
  readonly description: string;
  readonly icon: string;
  readonly hue: ModuleHue;
  readonly kind: 'native' | 'web' | 'mcp' | 'cli';
  readonly source: 'built-in';
  /** Part of the shell itself: always on. */
  readonly core?: boolean;
  /** Opens as a Deck tab under this label; `rail: false` keeps it off the rail's top. */
  readonly surface?: { readonly label: string; readonly icon: string; readonly rail?: false };
  /** Palette command ids this module owns; they hide while it is off. */
  readonly commands: readonly string[];
  /** Lands items in Today. */
  readonly items: boolean;
  /** Drives the attention pill and stack. */
  readonly signals: boolean;
  readonly needs: readonly Need[];
}

/** Relay's own capabilities, as modules. Rail order follows this list. */
export const BUILT_IN_MODULES: readonly ModuleManifest[] = [
  {
    id: 'today',
    name: 'Today',
    summary: 'Built in · triage',
    description:
      'Everything other modules report, in one list: what needs you, what is happening, and quiet updates.',
    icon: 'house',
    hue: 'relay',
    kind: 'native',
    source: 'built-in',
    core: true,
    surface: { label: 'Today', icon: 'house' },
    commands: [],
    items: false,
    signals: false,
    needs: [],
  },
  {
    id: 'linear',
    name: 'Linear',
    summary: 'Issues · your assigned work',
    description: 'Your assigned issues, projects and cycles from Linear.',
    icon: 'inbox',
    hue: 'linear',
    kind: 'native',
    source: 'built-in',
    surface: { label: 'My work', icon: 'inbox' },
    commands: ['relay.linear.open'],
    items: false,
    signals: false,
    needs: [{ permission: 'network', scope: 'api.linear.app' }],
  },
  {
    id: 'codex',
    name: 'Codex',
    summary: 'OpenAI · agent',
    description:
      'Codex threads in your workspaces. Ask from the Omnibar or the inspector; answers arrive as activity.',
    icon: 'sparkles',
    hue: 'agents',
    kind: 'cli',
    source: 'built-in',
    surface: { label: 'Agents', icon: 'sparkles' },
    commands: ['relay.agents.open'],
    items: true,
    signals: true,
    needs: [
      { permission: 'shell', scope: 'the Codex CLI' },
      { permission: 'files', scope: 'workspaces' },
      { permission: 'network', scope: 'OpenAI, through the CLI' },
    ],
  },
  {
    id: 'projects',
    name: 'Projects',
    summary: 'Built in · workspaces and scripts',
    description:
      'Your local workspaces, their GitHub repositories and Linear projects, and their package scripts.',
    icon: 'folder',
    hue: 'files',
    kind: 'native',
    source: 'built-in',
    surface: { label: 'Projects', icon: 'folder' },
    commands: ['relay.projects.open'],
    items: true,
    signals: true,
    needs: [
      { permission: 'files', scope: 'workspaces' },
      { permission: 'shell', scope: 'package scripts' },
    ],
  },
  {
    id: 'vault',
    name: 'Vault',
    summary: 'Built in · encrypted',
    description: 'Passwords and secrets, encrypted on this device and synced through Nexus.',
    icon: 'lock',
    hue: 'vault',
    kind: 'native',
    source: 'built-in',
    surface: { label: 'Vault', icon: 'lock' },
    commands: ['relay.vault.open'],
    items: false,
    signals: false,
    needs: [
      { permission: 'vault', scope: 'its own entries' },
      { permission: 'network', scope: 'Nexus sync' },
    ],
  },
  {
    id: 'runtime',
    name: 'Runtime',
    summary: 'Leaf, Nexus, Grafana',
    description: 'Health of the services Relay depends on, read from Leaf, Nexus and Grafana.',
    icon: 'activity',
    hue: 'runtime',
    kind: 'native',
    source: 'built-in',
    surface: { label: 'Runtime', icon: 'activity' },
    commands: ['relay.runtime.open'],
    items: false,
    signals: false,
    needs: [{ permission: 'network', scope: 'read only · Leaf, Nexus, Grafana' }],
  },
  {
    id: 'github',
    name: 'GitHub',
    summary: 'Pull requests, checks, notifications',
    description: 'Watches your repositories and reports reviews, checks and notifications.',
    icon: 'git-pull-request',
    hue: 'github',
    kind: 'native',
    source: 'built-in',
    commands: ['relay.github.open'],
    items: true,
    signals: true,
    needs: [{ permission: 'network', scope: 'api.github.com' }],
  },
  {
    id: 'gmail',
    name: 'Mail',
    summary: 'Gmail',
    description: 'New mail in your Gmail inbox, reported to Today and the attention stack.',
    icon: 'mail',
    hue: 'mail',
    kind: 'native',
    source: 'built-in',
    commands: [],
    items: true,
    signals: true,
    needs: [
      { permission: 'mail', scope: 'read your inbox' },
      { permission: 'network', scope: 'gmail.googleapis.com' },
    ],
  },
  {
    id: 'modules',
    name: 'Modules',
    summary: 'Built in · this screen',
    description: 'Every capability Relay has, what it gives and what it needs.',
    icon: 'blocks',
    hue: 'relay',
    kind: 'native',
    source: 'built-in',
    core: true,
    surface: { label: 'Modules', icon: 'blocks', rail: false },
    commands: [],
    items: false,
    signals: false,
    needs: [],
  },
  {
    id: 'settings',
    name: 'Settings',
    summary: 'Built in',
    description: 'General settings and connector accounts.',
    icon: 'settings',
    hue: 'relay',
    kind: 'native',
    source: 'built-in',
    core: true,
    surface: { label: 'Settings', icon: 'settings', rail: false },
    commands: ['relay.window.settings'],
    items: false,
    signals: false,
    needs: [],
  },
  {
    id: 'account',
    name: 'Nexus',
    summary: 'Built in · account and sync',
    description: 'Your Nexus identity, which signs Relay in and carries sync between devices.',
    icon: 'user',
    hue: 'relay',
    kind: 'native',
    source: 'built-in',
    core: true,
    surface: { label: 'Account', icon: 'user', rail: false },
    commands: [],
    items: false,
    signals: false,
    needs: [{ permission: 'network', scope: 'nexus.eresea.net' }],
  },
];

const OFF_SETTING_KEY = 'modules.off';

/**
 * Which modules exist and which are on. Every window holds its own copy and
 * reads the stored set, so the palette hides an off module's commands too.
 *
 * ponytail: built-in manifests only, enablement hides surfaces, items and
 * commands but the core keeps polling. Move this into the Rust core when
 * third-party modules arrive, so permissions are enforced where they matter.
 */
export class ModuleRegistry {
  private readonly tauri = inject(TauriBridge);
  private readonly off = signal<ReadonlySet<string>>(new Set());

  readonly all = BUILT_IN_MODULES;
  readonly enabled = computed(() => this.all.filter((m) => this.isEnabled(m.id)));

  get(id: string): ModuleManifest | undefined {
    return this.all.find((m) => m.id === id);
  }

  isEnabled(id: string): boolean {
    const module = this.get(id);
    return !!module && (module.core === true || !this.off().has(id));
  }

  /** A command no module claims belongs to the shell and is always available. */
  commandEnabled(commandId: string): boolean {
    const owner = this.all.find((m) => m.commands.includes(commandId));
    return !owner || this.isEnabled(owner.id);
  }

  async load(): Promise<void> {
    const stored = await this.tauri.getSetting<unknown>(OFF_SETTING_KEY, []);
    if (Array.isArray(stored)) {
      this.off.set(new Set(stored.filter((id): id is string => typeof id === 'string')));
    }
  }

  setEnabled(id: string, on: boolean): void {
    if (this.get(id)?.core) return;
    const next = new Set(this.off());
    if (on) next.delete(id);
    else next.add(id);
    this.off.set(next);
    void this.tauri.setSetting(OFF_SETTING_KEY, [...next]);
  }
}
