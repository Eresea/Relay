import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';

import { TauriBridge } from '@core/tauri';
import { ThemeService } from '@core/theme';
import { Github } from '@features/github/github';
import { Gmail } from '@features/gmail/gmail';
import { LinearSettings } from '@features/linear/linear-settings';
import { UmbraButtonComponent } from '@umbra/components/umbra-button/umbra-button.component';
import { UmbraInputComponent } from '@umbra/components/umbra-input/umbra-input.component';
import { UmbraSwitchComponent } from '@umbra/components/umbra-switch/umbra-switch.component';

const HUD_TOP_OFFSET_KEY = 'hud.topOffset';
const DEFAULT_HUD_TOP_OFFSET = 80;
const MAX_HUD_TOP_OFFSET = 2000;

/**
 * Relay's one settings surface, reached from the palette's "Open settings"
 * command (and, for the GitHub tab specifically, "GitHub" — see
 * `initialTab`). Everything here persists through `TauriBridge`'s settings
 * store (`settings.json` in the OS app-data directory) or, for
 * launch-at-login, through the OS's own autostart registration — never
 * local component state. The Gmail connector is the exception: its own
 * state lives core-side (see `src-tauri/src/gmail/mod.rs`), so `rl-gmail`
 * only reflects and edits it.
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
  imports: [
    Github,
    Gmail,
    LinearSettings,
    UmbraButtonComponent,
    UmbraInputComponent,
    UmbraSwitchComponent,
  ],
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
      <button
        type="button"
        class="tab"
        [class.active]="tab() === 'gmail'"
        (click)="tab.set('gmail')"
      >
        Gmail
      </button>
      <button
        type="button"
        class="tab"
        [class.active]="tab() === 'linear'"
        (click)="tab.set('linear')"
      >
        Linear
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
          <umbra-button size="sm" variant="link" (click)="theme.toggle()">
            Switch to {{ theme.theme() === 'dark' ? 'light' : 'dark' }}
          </umbra-button>
        </div>
        <div class="row">
          <div>
            <p class="label">Notification top offset</p>
            <p class="hint">Distance from the top-right corner, in pixels.</p>
          </div>
          <span class="number-input">
            <umbra-input
              type="number"
              [min]="0"
              [max]="2000"
              [step]="1"
              [value]="hudTopOffset().toString()"
              ariaLabel="Notification top offset in pixels"
              (valueChange)="saveHudTopOffset($event)"
            />
          </span>
        </div>
      </section>

      <section class="group">
        <h2 class="u-caption">Startup</h2>
        <div class="row">
          <div>
            <p class="label">Launch at login</p>
            <p class="hint">Starts hidden in the tray, the same as any other launch.</p>
          </div>
          <umbra-switch
            ariaLabel="Launch at login"
            [value]="launchAtLogin()"
            [disabled]="launchAtLoginPending()"
            (valueChange)="setLaunchAtLogin($event)"
          />
        </div>
      </section>
    </div>

    <div [hidden]="tab() !== 'github'">
      <rl-github />
    </div>

    <div [hidden]="tab() !== 'gmail'">
      <rl-gmail />
    </div>

    <div [hidden]="tab() !== 'linear'">
      <rl-linear-settings />
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

    :host ::ng-deep .row umbra-button {
      flex: none;
    }

    .number-input {
      inline-size: 76px;
      flex: none;
      display: block;
    }

    :host ::ng-deep .number-input input {
      text-align: end;
    }
  `,
})
export class Settings {
  /** Which tab to select right now. Home sets this from which palette command opened Settings. */
  readonly initialTab = input<'general' | 'github' | 'gmail' | 'linear'>('general');

  private readonly tauri = inject(TauriBridge);
  protected readonly theme = inject(ThemeService);

  protected readonly tab = signal<'general' | 'github' | 'gmail' | 'linear'>('general');
  protected readonly launchAtLogin = signal(false);
  protected readonly launchAtLoginPending = signal(true);
  protected readonly hudTopOffset = signal(DEFAULT_HUD_TOP_OFFSET);

  constructor() {
    effect(() => this.tab.set(this.initialTab()));

    void this.tauri.isAutostartEnabled().then((enabled) => {
      this.launchAtLogin.set(enabled);
      this.launchAtLoginPending.set(false);
    });

    void this.tauri
      .getSetting<number>(HUD_TOP_OFFSET_KEY, DEFAULT_HUD_TOP_OFFSET)
      .then((offset) => this.hudTopOffset.set(clampHudTopOffset(offset)));
  }

  protected saveHudTopOffset(value: string): void {
    const offset = clampHudTopOffset(Number.parseInt(value, 10));
    this.hudTopOffset.set(offset);
    void this.tauri.setSetting(HUD_TOP_OFFSET_KEY, offset);
  }

  protected setLaunchAtLogin(next: boolean): void {
    const previous = this.launchAtLogin();
    this.launchAtLogin.set(next);
    this.launchAtLoginPending.set(true);

    void this.tauri
      .setAutostart(next)
      .catch(() => this.launchAtLogin.set(previous))
      .finally(() => this.launchAtLoginPending.set(false));
  }
}

function clampHudTopOffset(offset: number): number {
  return Number.isFinite(offset)
    ? Math.min(MAX_HUD_TOP_OFFSET, Math.max(0, Math.round(offset)))
    : DEFAULT_HUD_TOP_OFFSET;
}
