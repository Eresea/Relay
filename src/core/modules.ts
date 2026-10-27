import { computed, signal } from '@/lib/signals';
import { inject } from '@/lib/inject';

import type { ModuleHue } from './entity-hue';
import { TauriBridge } from './tauri';

/** What a module may touch. Mirrors `modules::Permission` in the core. */
export type Permission = 'shell' | 'files' | 'network' | 'mail' | 'vault';

export const PERMISSIONS: Readonly<Record<Permission, string>> = {
  shell: 'Run programs',
  files: 'Read and write files',
  network: 'Reach the network',
  mail: 'Read and send mail',
  vault: 'Read the vault',
};

export interface Need {
  readonly permission: Permission;
  /** Where the permission applies: "workspaces", "api.github.com". */
  readonly scope: string;
}

/**
 * A module's contract with the shell, as the core declares it in
 * src-tauri/src/modules.rs: what it gives (commands, Today items, a surface,
 * attention signals) and what it needs.
 */
export interface ModuleManifest {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly icon: string;
  readonly hue: ModuleHue;
  readonly kind: 'native' | 'web' | 'mcp' | 'cli';
  /** Built into Relay, or a web app you pinned. */
  readonly source: 'built-in' | 'pinned';
  /** Part of the shell itself: always on. */
  readonly core: boolean;
  /** Opens as a Deck tab; `rail: false` keeps it to its own button. */
  readonly surface: {
    readonly label: string;
    readonly icon: string;
    readonly rail: boolean;
  } | null;
  /** Palette command ids this module owns. */
  readonly commands: readonly string[];
  readonly items: boolean;
  readonly signals: boolean;
  readonly needs: readonly Need[];
  /** A pinned web app's address. */
  readonly url?: string;
}

export interface ModuleInfo extends ModuleManifest {
  readonly enabled: boolean;
}

/**
 * The interface's copy of the core's module registry. The core owns the
 * manifests and which modules are on, refuses an off module's commands and
 * stops its background work; this copy only draws from it, and re-reads it
 * whenever the core says it changed.
 */
export class ModuleRegistry {
  private readonly tauri = inject(TauriBridge);
  private readonly state = signal<readonly ModuleInfo[]>([]);

  readonly all = this.state.asReadonly();
  readonly enabled = computed(() => this.state().filter((m) => m.enabled));

  get(id: string): ModuleInfo | undefined {
    return this.state().find((m) => m.id === id);
  }

  isEnabled(id: string): boolean {
    return this.get(id)?.enabled === true;
  }

  /** A command no module claims belongs to the shell and is always available. */
  commandEnabled(commandId: string): boolean {
    const owner = this.state().find((m) => m.commands.includes(commandId));
    return !owner || owner.enabled;
  }

  async load(): Promise<void> {
    this.state.set(await this.tauri.modulesList());
  }

  /** Shows the change at once; the core's answer, or its refusal, settles it. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.state.update((list) => list.map((m) => (m.id === id ? { ...m, enabled } : m)));
    try {
      await this.tauri.modulesSetEnabled(id, enabled);
    } finally {
      await this.load();
    }
  }
}
