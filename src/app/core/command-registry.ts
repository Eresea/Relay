import { Injectable, computed, signal } from '@angular/core';

import type { Command } from './command';

/**
 * The single place commands live. Features register on init and dispose on
 * teardown; the palette reads the resulting list.
 */
@Injectable({ providedIn: 'root' })
export class CommandRegistry {
  private readonly entries = signal<readonly Command[]>([]);

  readonly commands = computed(() => this.entries());

  /** Registers commands and returns a disposer that removes exactly these. */
  register(...commands: readonly Command[]): () => void {
    const ids = new Set(commands.map((c) => c.id));
    const existing = this.entries().filter((c) => ids.has(c.id));
    if (existing.length > 0) {
      throw new Error(`Command ids already registered: ${existing.map((c) => c.id).join(', ')}`);
    }

    this.entries.update((list) => [...list, ...commands]);
    return () => this.entries.update((list) => list.filter((c) => !ids.has(c.id)));
  }

  byId(id: string): Command | undefined {
    return this.entries().find((c) => c.id === id);
  }
}
