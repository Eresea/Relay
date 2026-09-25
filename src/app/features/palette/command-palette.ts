import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
  viewChildren,
  type ElementRef,
} from '@angular/core';

import type { Command, CommandMatch } from '@core/command';
import { CommandRegistry } from '@core/command-registry';
import { hueVar } from '@core/entity-hue';
import { search } from '@core/fuzzy';
import { TauriBridge } from '@core/tauri';
import { RECENT_COMMANDS_KEY, recentCommands, updateRecentCommandIds } from '@core/recent-commands';
import { Icon } from '@shared/icon';
import { Kbd } from '@shared/kbd';

interface TitlePart {
  readonly text: string;
  readonly matched: boolean;
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
  private focusGeneration = 0;
  private paletteBlurred = false;

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  /** DOM order matches `flat()`'s order, since both are driven by the same
   * `sections()` computed — so `rows()[activeIndex()]` is always the row
   * currently selected. */
  private readonly rows = viewChildren<ElementRef<HTMLElement>>('row');

  protected readonly query = signal('');
  protected readonly activeIndex = signal(0);
  protected readonly recentIds = signal<readonly string[]>([]);
  protected readonly running = signal(false);
  protected readonly runError = signal(false);

  protected readonly matches = computed(() => search(this.registry.commands(), this.query()));

  protected readonly flat = computed(() => {
    const matches = this.matches();
    if (this.query().trim()) return matches;

    const byId = new Map(matches.map((match) => [match.command.id, match]));
    const recent = recentCommands(
      matches.map((match) => match.command),
      this.recentIds(),
    ).flatMap((command) => {
      const match = byId.get(command.id);
      return match ? [match] : [];
    });
    const recentIds = new Set(recent.map((match) => match.command.id));
    return [...recent, ...matches.filter((match) => !recentIds.has(match.command.id))];
  });

  protected readonly active = computed(() => this.flat()[this.activeIndex()]?.command);

  constructor() {
    // Runs after the DOM reflects the current activeIndex, so the row being
    // scrolled to actually exists. Arrowing past the visible rows without
    // this walks the selection off-screen with no visual sign it moved.
    afterRenderEffect(() => {
      this.rows()[this.activeIndex()]?.nativeElement.scrollIntoView({ block: 'nearest' });
    });

    // The palette window is created once and only shown/hidden, never
    // reloaded (see overlay.rs), so there is no fresh page load to autofocus
    // on each open — only the OS focus event marks "the palette is back".
    const destroyRef = inject(DestroyRef);
    void this.tauri
      .onWindowFocusChanged((focused) => {
        if (focused) {
          if (this.paletteBlurred) {
            this.focusGeneration++;
            this.paletteBlurred = false;
          }
          this.field().nativeElement.focus();
        } else {
          this.paletteBlurred = true;
        }
      })
      .then((unlisten) => destroyRef.onDestroy(unlisten));

    void this.tauri.getSetting<unknown>(RECENT_COMMANDS_KEY, []).then((stored) => {
      if (Array.isArray(stored)) {
        this.recentIds.set(stored.filter((id): id is string => typeof id === 'string'));
      }
    });
  }

  protected onQuery(value: string): void {
    this.query.set(value);
    this.activeIndex.set(0);
    this.runError.set(false);
  }

  protected hue(command: Command): string | null {
    return command.hue ? hueVar(command.hue) : null;
  }

  protected titleParts(match: CommandMatch): readonly TitlePart[] {
    const parts: TitlePart[] = [];
    let cursor = 0;
    for (const [start, end] of match.ranges) {
      if (start > cursor)
        parts.push({ text: match.command.title.slice(cursor, start), matched: false });
      parts.push({ text: match.command.title.slice(start, end), matched: true });
      cursor = end;
    }
    if (cursor < match.command.title.length) {
      parts.push({ text: match.command.title.slice(cursor), matched: false });
    }
    return parts;
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
      case 'Tab':
        if (this.query().trim() && this.active()) {
          event.preventDefault();
          const input = this.field().nativeElement;
          input.value = this.active()!.title;
          this.onQuery(input.value);
        }
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
    if (this.running()) return;
    const focusGeneration = this.focusGeneration;
    const recent = updateRecentCommandIds(this.recentIds(), command.id);
    this.recentIds.set(recent);
    void this.tauri.setSetting(RECENT_COMMANDS_KEY, recent);
    this.running.set(true);
    this.runError.set(false);
    this.field().nativeElement.focus();
    try {
      await command.run();
    } catch {
      this.running.set(false);
      if (focusGeneration === this.focusGeneration) this.runError.set(true);
      return;
    }
    this.running.set(false);
    if (focusGeneration !== this.focusGeneration) return;
    await this.dismiss();
  }

  private async runActive(): Promise<void> {
    if (this.running()) return;
    const command = this.active();
    if (command) await this.run(command);
  }

  private async dismiss(): Promise<void> {
    if (this.running()) this.focusGeneration++;
    this.query.set('');
    this.activeIndex.set(0);
    this.runError.set(false);
    this.field().nativeElement.value = '';
    await this.tauri.dismissPalette();
  }

  private move(delta: number): void {
    if (this.running()) return;
    const count = this.flat().length;
    if (count === 0) return;
    this.activeIndex.update((i) => (i + delta + count) % count);
  }
}
