import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';

import type { Command, CommandMatch } from '@core/command';
import { CommandRegistry } from '@core/command-registry';
import { hueVar } from '@core/entity-hue';
import { search } from '@core/fuzzy';
import { TauriBridge } from '@core/tauri';
import { Icon } from '@shared/icon';
import { Kbd } from '@shared/kbd';

interface Section {
  readonly group: string;
  readonly matches: readonly CommandMatch[];
}

/**
 * Relay's primary navigation surface. The screens are deliberately sparse; the
 * palette is where the removed density goes.
 */
@Component({
  selector: 'rl-command-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Kbd],
  templateUrl: './command-palette.html',
  styleUrl: './command-palette.css',
  host: {
    class: 'u-glass u-chrome',
    '(keydown)': 'onKeydown($event)',
  },
})
export class CommandPalette {
  private readonly registry = inject(CommandRegistry);
  private readonly tauri = inject(TauriBridge);

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  protected readonly query = signal('');
  protected readonly activeIndex = signal(0);

  protected readonly matches = computed(() => search(this.registry.commands(), this.query()));

  protected readonly sections = computed<readonly Section[]>(() => {
    const byGroup = new Map<string, CommandMatch[]>();
    for (const match of this.matches()) {
      const bucket = byGroup.get(match.command.group);
      if (bucket) bucket.push(match);
      else byGroup.set(match.command.group, [match]);
    }
    return [...byGroup].map(([group, matches]) => ({ group, matches }));
  });

  /** Flat order, so arrow keys cross group boundaries without noticing them. */
  protected readonly flat = computed(() => this.sections().flatMap((s) => s.matches));

  protected readonly active = computed(() => this.flat()[this.activeIndex()]?.command);

  protected onQuery(value: string): void {
    this.query.set(value);
    this.activeIndex.set(0);
  }

  protected indexOf(match: CommandMatch): number {
    return this.flat().indexOf(match);
  }

  protected hue(command: Command): string | null {
    return command.hue ? hueVar(command.hue) : null;
  }

  protected onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.move(-1);
        break;
      case 'Enter':
        event.preventDefault();
        void this.runActive();
        break;
      case 'Escape':
        event.preventDefault();
        void this.dismiss();
        break;
      default:
        break;
    }
  }

  protected async run(command: Command): Promise<void> {
    await command.run();
    await this.dismiss();
  }

  private async runActive(): Promise<void> {
    const command = this.active();
    if (command) await this.run(command);
  }

  private async dismiss(): Promise<void> {
    this.query.set('');
    this.activeIndex.set(0);
    this.field().nativeElement.value = '';
    await this.tauri.dismissPalette();
  }

  private move(delta: number): void {
    const count = this.flat().length;
    if (count === 0) return;
    this.activeIndex.update((i) => (i + delta + count) % count);
  }
}
