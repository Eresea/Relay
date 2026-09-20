import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';

import { TauriBridge } from '@core/tauri';
import { ThemeService } from '@core/theme';
import { Github } from '@features/github/github';

/**
 * Relay's one settings surface, reached from the palette's "Open settings"
 * command (and, for the GitHub tab specifically, "GitHub" — see
 * `initialTab`). Everything here persists through `TauriBridge`'s settings
 * store (`settings.json` in the OS app-data directory) or, for
 * launch-at-login, through the OS's own autostart registration — never
 * local component state.
 *
 * Tab content is hidden with `[hidden]` rather than an `@if`, which would
 * destroy and recreate `rl-github` on every switch away from its tab. A
 * Device Flow connection attempt can take anywhere from a few seconds to a
 * couple of minutes (however long the user takes to approve it on GitHub);
 * destroying that component mid-wait would drop its event listener and
 * silently lose the transition to "connected".
 */
@Component({
  selector: 'rl-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Github],
  template: `
    <nav class="tabs">
      <button
        type="button"
        class="tab"
        [class.active]="tab() === 'general'"
        (click)="tab.set('general')"
      >
        General
      </button>
      <button
        type="button"
        class="tab"
        [class.active]="tab() === 'github'"
        (click)="tab.set('github')"
      >
        GitHub
      </button>
    </nav>

    <div [hidden]="tab() !== 'general'">
      <section class="group">
        <h2 class="u-caption">Appearance</h2>
        <div class="row">
          <div>
            <p class="label">Theme</p>
            <p class="hint">{{ theme.theme() === 'dark' ? 'Dark' : 'Light' }} is active.</p>
          </div>
          <button type="button" class="link" (click)="theme.toggle()">
            Switch to {{ theme.theme() === 'dark' ? 'light' : 'dark' }}
          </button>
        </div>
      </section>

      <section class="group">
        <h2 class="u-caption">Startup</h2>
        <div class="row">
          <div>
            <p class="label">Launch at login</p>
            <p class="hint">Starts hidden in the tray, the same as any other launch.</p>
          </div>
          <button
            type="button"
            role="switch"
            class="switch"
            [attr.aria-checked]="launchAtLogin()"
            [disabled]="launchAtLoginPending()"
            (click)="toggleLaunchAtLogin()"
          >
            <span class="switch-thumb"></span>
          </button>
        </div>
      </section>
    </div>

    <div [hidden]="tab() !== 'github'">
      <rl-github />
    </div>
  `,
  styles: `
    :host {
      display: block;
      inline-size: 100%;
      max-inline-size: var(--content-max);
      margin-inline: auto;
      padding: var(--space-8);
    }

    .tabs {
      display: flex;
      gap: var(--space-2);
      margin-block-end: var(--space-6);
      border-block-end: 1px solid var(--border-subtle);
    }

    .tab {
      padding: var(--space-3) var(--space-2);
      margin-block-end: -1px;
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
      color: var(--text-muted);
      border-block-end: 2px solid transparent;
      transition:
        color var(--dur-hover) var(--ease-standard),
        border-color var(--dur-hover) var(--ease-standard);
    }

    .tab:hover {
      color: var(--text-body);
    }

    .tab.active {
      color: var(--text-body);
      border-block-end-color: var(--accent);
    }

    .group + .group {
      margin-block-start: var(--space-8);
    }

    .group h2 {
      margin: 0 0 var(--space-4);
    }

    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-6);
      padding: var(--space-5) 0;
      border-block-end: 1px solid var(--border-subtle);
    }

    .row:last-child {
      border-block-end: none;
    }

    .label {
      margin: 0;
      font-size: var(--text-13);
      color: var(--text-body);
    }

    .hint {
      margin: var(--space-1) 0 0;
      font-size: var(--text-12);
      color: var(--text-muted);
    }

    .link {
      flex: none;
      font-size: var(--text-13);
      color: var(--accent);
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-sm);
      transition: background-color var(--dur-hover) var(--ease-standard);
    }

    .link:hover {
      background: var(--tint-hover);
    }

    .switch {
      position: relative;
      flex: none;
      inline-size: 36px;
      block-size: 20px;
      border-radius: var(--radius-pill);
      background: var(--border-subtle);
      transition: background-color var(--dur-hover) var(--ease-standard);
    }

    .switch[aria-checked='true'] {
      background: var(--accent);
    }

    .switch:disabled {
      opacity: 0.6;
    }

    .switch-thumb {
      position: absolute;
      inset-block-start: 2px;
      inset-inline-start: 2px;
      inline-size: 16px;
      block-size: 16px;
      border-radius: var(--radius-pill);
      background: var(--bg-app);
      transition: transform var(--dur-hover) var(--ease-standard);
    }

    .switch[aria-checked='true'] .switch-thumb {
      transform: translateX(16px);
    }
  `,
})
export class Settings {
  /** Which tab to select right now. Home sets this from which palette command opened Settings. */
  readonly initialTab = input<'general' | 'github'>('general');

  private readonly tauri = inject(TauriBridge);
  protected readonly theme = inject(ThemeService);

  protected readonly tab = signal<'general' | 'github'>('general');
  protected readonly launchAtLogin = signal(false);
  protected readonly launchAtLoginPending = signal(true);

  constructor() {
    effect(() => this.tab.set(this.initialTab()));

    void this.tauri.isAutostartEnabled().then((enabled) => {
      this.launchAtLogin.set(enabled);
      this.launchAtLoginPending.set(false);
    });
  }

  protected toggleLaunchAtLogin(): void {
    const next = !this.launchAtLogin();
    this.launchAtLogin.set(next);
    this.launchAtLoginPending.set(true);

    void this.tauri
      .setAutostart(next)
      .catch(() => this.launchAtLogin.set(!next))
      .finally(() => this.launchAtLoginPending.set(false));
  }
}
