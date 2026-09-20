import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';

import { TauriBridge } from '@core/tauri';
import { ThemeService } from '@core/theme';
import { Settings } from '@features/settings/settings';
import { Vault } from '@features/vault/vault';
import { Icon } from '@shared/icon';
import { Kbd } from '@shared/kbd';

/**
 * The main window. Deliberately almost empty: Relay's job is to stay out of the
 * way, and everything that matters is behind the palette. `decorations: false`
 * in tauri.conf.json means the OS draws no title bar of its own, so the
 * minimize/maximize/close buttons here are the only way to work the window —
 * without them the window could only be closed from the tray.
 */
@Component({
  selector: 'rl-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Kbd, Settings, Vault],
  template: `
    <header class="titlebar u-chrome" data-tauri-drag-region>
      @if (view() !== 'home') {
        <button type="button" class="back" (click)="view.set('home')" aria-label="Back">
          <rl-icon name="arrow-left" [size]="16" />
          <span>{{ viewTitle() }}</span>
        </button>
      } @else {
        <span class="wordmark">Relay</span>
      }
      <div class="window-controls">
        <button type="button" class="theme" (click)="theme.toggle()" aria-label="Toggle theme">
          <rl-icon [name]="theme.theme() === 'dark' ? 'sun' : 'moon'" [size]="16" />
        </button>
        <button type="button" class="window-btn" (click)="minimize()" aria-label="Minimize">
          <rl-icon name="minus" [size]="14" />
        </button>
        <button
          type="button"
          class="window-btn"
          (click)="toggleMaximize()"
          [attr.aria-label]="maximized() ? 'Restore' : 'Maximize'"
        >
          <rl-icon [name]="maximized() ? 'copy' : 'square'" [size]="14" />
        </button>
        <button type="button" class="window-btn close" (click)="close()" aria-label="Close">
          <rl-icon name="x" [size]="14" />
        </button>
      </div>
    </header>

    @if (view() === 'settings') {
      <rl-settings [initialTab]="settingsTab()" />
    } @else if (view() === 'vault') {
      <rl-vault />
    } @else {
      <main>
        <div class="cold-start">
          <p class="u-title">A quiet place to work</p>
          <p class="body">Everything else is behind <rl-kbd [keys]="paletteKeys" />.</p>
        </div>
      </main>
    }
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

    .back {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      margin-inline-start: calc(var(--space-3) * -1);
      padding: var(--space-2) var(--space-3);
      font-size: var(--text-13);
      font-weight: var(--weight-semibold);
      color: var(--text-body);
      border-radius: var(--radius-sm);
      transition: background-color var(--dur-hover) var(--ease-standard);
    }

    .back:hover {
      background: var(--tint-hover);
    }

    .window-controls {
      display: flex;
      align-items: center;
      gap: var(--space-1);
    }

    .theme,
    .window-btn {
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

    .theme:hover,
    .window-btn:hover {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .window-btn.close:hover {
      color: var(--danger-ink);
      background: var(--danger);
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
  protected readonly view = signal<'home' | 'settings' | 'vault'>('home');
  protected readonly settingsTab = signal<'general' | 'github'>('general');
  protected readonly viewTitle = computed(() => {
    switch (this.view()) {
      case 'settings':
        return 'Settings';
      case 'vault':
        return 'Password vault';
      default:
        return '';
    }
  });

  private readonly tauri = inject(TauriBridge);
  protected readonly maximized = signal(false);

  constructor() {
    void this.tauri.isWindowMaximized().then((value) => this.maximized.set(value));

    const destroyRef = inject(DestroyRef);
    void this.tauri
      .onWindowResized(
        () => void this.tauri.isWindowMaximized().then((value) => this.maximized.set(value)),
      )
      .then((unlisten) => destroyRef.onDestroy(unlisten));

    // The palette that dispatched "Open settings" and this window are
    // separate webviews with no shared JS state, so the core tells us to
    // switch views over the event channel rather than us reading any local
    // signal it could have set directly.
    void this.tauri
      .onEvent((event) => {
        if (event.type === 'openSettingsRequested') {
          this.view.set('settings');
          this.settingsTab.set('general');
        }
        if (event.type === 'openVaultRequested') this.view.set('vault');
        if (event.type === 'openGithubRequested') {
          this.view.set('settings');
          this.settingsTab.set('github');
        }
      })
      .then((unlisten) => destroyRef.onDestroy(unlisten));
  }

  protected minimize(): void {
    void this.tauri.minimizeWindow();
  }

  protected toggleMaximize(): void {
    void this.tauri.toggleMaximizeWindow();
  }

  protected close(): void {
    void this.tauri.closeWindow();
  }
}
