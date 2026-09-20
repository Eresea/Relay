import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';

import { TauriBridge } from '@core/tauri';
import { ThemeService } from '@core/theme';
import { Settings } from '@features/settings/settings';
import { Vault } from '@features/vault/vault';
import { Icon } from '@shared/icon';
import { Kbd } from '@shared/kbd';

/**
 * The main window. `decorations: false` in tauri.conf.json means the OS draws
 * no title bar of its own, so everything here — including the
 * minimize/maximize/close buttons and the left rail navigation — is drawn by
 * the app itself and must behave like a native shell: a titlebar that never
 * scrolls out of view, and window buttons flush against the window's own top
 * and right edges rather than floating inside a padded box.
 */
@Component({
  selector: 'rl-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Kbd, Settings, Vault],
  template: `
    <header class="titlebar u-chrome" data-tauri-drag-region>
      <div class="titlebar-start">
        <button
          type="button"
          class="rail-toggle"
          (click)="railExpanded.set(!railExpanded())"
          [attr.aria-label]="railExpanded() ? 'Collapse sidebar' : 'Expand sidebar'"
        >
          <rl-icon name="panel-left" [size]="16" />
        </button>
        <button type="button" class="wordmark" (click)="view.set('home')">Relay</button>
      </div>
      <div class="window-controls">
        <button type="button" class="window-btn" (click)="theme.toggle()" aria-label="Toggle theme">
          <rl-icon [name]="theme.theme() === 'dark' ? 'sun' : 'moon'" [size]="14" />
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

    <div class="body">
      <nav class="rail u-chrome" [class.expanded]="railExpanded()">
        <button
          type="button"
          class="rail-item"
          [class.active]="view() === 'settings'"
          (click)="openSettings()"
          aria-label="Settings"
        >
          <rl-icon name="settings" [size]="16" />
          <span class="rail-label">Settings</span>
        </button>
      </nav>

      <main class="content">
        @if (view() === 'settings') {
          <rl-settings [initialTab]="settingsTab()" />
        } @else if (view() === 'vault') {
          <rl-vault />
        } @else {
          <div class="cold-start-wrap">
            <div class="cold-start">
              <p class="u-title">A quiet place to work</p>
              <p class="body">Everything else is behind <rl-kbd [keys]="paletteKeys" />.</p>
            </div>
          </div>
        }
      </main>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      block-size: 100%;
      overflow: hidden;
    }

    /* Fixed, edge-to-edge titlebar: never scrolls, and its own top/right
     * edges are the window's top/right edges so the caption buttons sit
     * exactly where a native titlebar would put them. */
    .titlebar {
      display: flex;
      align-items: stretch;
      justify-content: space-between;
      flex: none;
      block-size: var(--titlebar-height);
      padding-inline-start: var(--space-4);
      border-block-end: 1px solid var(--border-subtle);
      background: var(--bg-sunken);
    }

    .titlebar-start {
      display: flex;
      align-items: center;
      gap: var(--space-4);
    }

    .rail-toggle {
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

    .rail-toggle:hover {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .wordmark {
      font-size: var(--text-13);
      font-weight: var(--weight-semibold);
      letter-spacing: -0.045em;
      color: var(--text-body);
    }

    .window-controls {
      display: flex;
      align-items: stretch;
    }

    .window-btn {
      display: grid;
      place-items: center;
      inline-size: 46px;
      block-size: 100%;
      color: var(--text-subtle);
      border-radius: 0;
      transition:
        background-color var(--dur-hover) var(--ease-standard),
        color var(--dur-hover) var(--ease-standard);
    }

    .window-btn:hover {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .window-btn.close:hover {
      color: var(--danger-ink);
      background: var(--danger);
    }

    .body {
      display: flex;
      flex: 1;
      min-block-size: 0;
    }

    .rail {
      display: flex;
      flex-direction: column;
      flex: none;
      gap: var(--space-2);
      inline-size: var(--sidebar-width-collapsed);
      padding: var(--space-3);
      border-inline-end: 1px solid var(--border-subtle);
      background: var(--bg-sunken);
      transition: inline-size var(--dur-panel) var(--ease-standard);
      overflow: hidden;
    }

    .rail.expanded {
      inline-size: var(--sidebar-width);
    }

    .rail-item {
      display: flex;
      align-items: center;
      gap: var(--space-4);
      inline-size: 100%;
      block-size: var(--control-md);
      padding-inline: var(--space-3);
      color: var(--text-subtle);
      border-radius: var(--radius-sm);
      transition:
        background-color var(--dur-hover) var(--ease-standard),
        color var(--dur-hover) var(--ease-standard);
    }

    .rail-item:hover {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .rail-item.active {
      color: var(--text-strong);
      background: var(--tint-hover);
    }

    .rail-label {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
    }

    .content {
      flex: 1;
      min-inline-size: 0;
      overflow-y: auto;
    }

    .cold-start-wrap {
      display: grid;
      place-items: center;
      min-block-size: 100%;
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
  protected readonly railExpanded = signal(true);
  protected readonly settingsTab = signal<'general' | 'github'>('general');

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

  protected openSettings(): void {
    this.view.set('settings');
    this.settingsTab.set('general');
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
