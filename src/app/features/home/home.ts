import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ThemeService } from '@core/theme';
import { Icon } from '@shared/icon';
import { Kbd } from '@shared/kbd';

/**
 * The main window. Deliberately almost empty: Relay's job is to stay out of the
 * way, and everything that matters is behind the palette.
 */
@Component({
  selector: 'rl-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Kbd],
  template: `
    <header class="titlebar u-chrome" data-tauri-drag-region>
      <span class="wordmark">Relay</span>
      <button type="button" class="theme" (click)="theme.toggle()" aria-label="Toggle theme">
        <rl-icon [name]="theme.theme() === 'dark' ? 'sun' : 'moon'" [size]="16" />
      </button>
    </header>

    <main>
      <div class="cold-start">
        <p class="u-title">A quiet place to work</p>
        <p class="body">Everything else is behind <rl-kbd [keys]="paletteKeys" />.</p>
      </div>
    </main>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      block-size: 100%;
    }

    .titlebar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex: none;
      block-size: var(--titlebar-height);
      padding: 0 var(--space-5);
      border-block-end: 1px solid var(--border-subtle);
      background: var(--bg-sunken);
    }

    .wordmark {
      font-size: var(--text-13);
      font-weight: var(--weight-semibold);
      letter-spacing: -0.045em;
      color: var(--text-body);
    }

    .theme {
      display: grid;
      place-items: center;
      inline-size: var(--control-sm);
      block-size: var(--control-sm);
      color: var(--text-subtle);
      border-radius: var(--radius-sm);
      transition:
        background-color var(--dur-hover) var(--ease-standard),
        color var(--dur-hover) var(--ease-standard);
    }

    .theme:hover {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    main {
      display: grid;
      place-items: center;
      flex: 1;
      padding: var(--space-8);
    }

    .cold-start {
      max-inline-size: var(--content-max);
      text-align: center;
    }

    .cold-start .body {
      display: flex;
      gap: var(--space-3);
      align-items: center;
      justify-content: center;
      margin: var(--space-4) 0 0;
      font-size: var(--text-13);
      color: var(--text-muted);
    }
  `,
})
export class Home {
  protected readonly theme = inject(ThemeService);
  protected readonly paletteKeys = ['Ctrl', 'Space'] as const;
}
