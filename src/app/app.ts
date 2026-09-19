import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';

import { CommandRegistry } from '@core/command-registry';
import { registerDefaultCommands } from '@core/default-commands';
import { currentSurface, isOverlaySurface } from '@core/surface';
import { TauriBridge } from '@core/tauri';
import { ThemeService } from '@core/theme';
import { CommandPalette } from '@features/palette/command-palette';
import { Home } from '@features/home/home';

/**
 * Relay renders one of three surfaces depending on which window is asking.
 * The overlay surfaces take the glass tier and a transparent document; the
 * main window is a flat, opaque app surface.
 */
@Component({
  selector: 'rl-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommandPalette, Home],
  template: `
    @switch (surface) {
      @case ('palette') {
        <rl-command-palette />
      }
      @case ('hud') {
        <!-- Populated by the notification stream; empty until one arrives. -->
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

  protected readonly surface = currentSurface();
  protected readonly coreReady = signal(false);

  constructor() {
    // Touch the theme service so the effect that writes data-theme runs.
    inject(ThemeService);

    if (isOverlaySurface(this.surface)) {
      document.documentElement.classList.add('overlay-window');
    }

    const dispose = registerDefaultCommands();
    inject(DestroyRef).onDestroy(dispose);

    void this.mergeCoreCommands();
  }

  /** Commands owned by the Rust side — system actions, service control. */
  private async mergeCoreCommands(): Promise<void> {
    const core = await this.tauri.coreCommands();
    if (core.length > 0) {
      this.registry.register(
        ...core.map((c) => ({
          ...c,
          run: () => this.tauri.runCoreCommand(c.id),
        })),
      );
    }
    this.coreReady.set(true);
  }
}
