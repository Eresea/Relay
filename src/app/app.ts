import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';

import { CommandRegistry } from '@core/command-registry';
import { registerDefaultCommands } from '@core/default-commands';
import { NotificationCenter } from '@core/notification-center';
import { currentSurface, isOverlaySurface } from '@core/surface';
import { TauriBridge, type CoreCommand } from '@core/tauri';
import { ThemeService } from '@core/theme';
import { CommandPalette } from '@features/palette/command-palette';
import { Home } from '@features/home/home';
import { HudSurface } from '@features/hud/hud-surface';

/**
 * Relay renders one of three surfaces depending on which window is asking.
 * The overlay surfaces take the glass tier and a transparent document; the
 * main window is a flat, opaque app surface.
 */
@Component({
  selector: 'rl-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommandPalette, Home, HudSurface],
  template: `
    @switch (surface) {
      @case ('palette') {
        <rl-command-palette />
      }
      @case ('hud') {
        <rl-hud-surface />
      }
      @default {
        <rl-home />
      }
    }
  `,
  styles: `
    :host {
      display: block;
      block-size: 100%;
    }
  `,
})
export class App {
  private readonly registry = inject(CommandRegistry);
  private readonly tauri = inject(TauriBridge);
  private readonly notifications = inject(NotificationCenter);

  protected readonly surface = currentSurface();

  constructor() {
    // Touch the theme service so the effect that writes data-theme runs.
    inject(ThemeService);

    if (isOverlaySurface(this.surface)) {
      document.documentElement.classList.add('overlay-window');
    }

    const dispose = registerDefaultCommands();
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(dispose);

    void this.mergeCoreCommands();
    void this.subscribeToEvents(destroyRef);
  }

  /** Commands owned by the Rust side — system actions, service control. */
  private async mergeCoreCommands(): Promise<void> {
    const core = await this.tauri.coreCommands();
    if (core.length > 0) {
      this.registry.register(
        ...core.map((c) => ({
          ...c,
          // c.id comes from the same Rust source as CoreCommand's ids
          // (core_commands.rs tests this pairing), but arrives here as a
          // plain string — TS cannot see that connection statically.
          run: () => this.tauri.runCoreCommand({ id: c.id } as CoreCommand),
        })),
      );
    }
  }

  /** Routes the core's push channel into whichever service owns that kind of event. */
  private async subscribeToEvents(destroyRef: DestroyRef): Promise<void> {
    const unlisten = await this.tauri.onEvent((event) => this.notifications.handle(event));
    destroyRef.onDestroy(unlisten);
  }
}
