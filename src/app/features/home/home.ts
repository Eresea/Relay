import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';

import { NexusAccount } from '@core/nexus-account';
import { TauriBridge } from '@core/tauri';
import { ThemeService } from '@core/theme';
import { Settings } from '@features/settings/settings';
import { UpdateStatusBar } from '@features/updates/update-center';
import { Vault } from '@features/vault/vault';
import { BackgroundTaskIndicator } from '@shared/background-task-indicator';
import { AppPopover, PopoverContent, PopoverTrigger } from '@shared/app-popover';
import { Icon } from '@shared/icon';
import { NotificationPopover } from '@shared/notification-popover';
import { Projects } from '@features/projects/projects';
import { Runtime } from '@features/runtime/runtime';
import { Codex } from '@features/codex/codex';

const RAIL_EXPANDED_SETTING_KEY = 'rail.expanded';

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
  imports: [
    AppPopover,
    PopoverContent,
    PopoverTrigger,
    BackgroundTaskIndicator,
    Codex,
    Icon,
    NotificationPopover,
    Projects,
    Runtime,
    Settings,
    UpdateStatusBar,
    Vault,
  ],
  template: `
    <header class="titlebar u-chrome" data-tauri-drag-region>
      <div class="titlebar-start">
        <button
          type="button"
          class="home-btn"
          [class.active]="view() === 'home'"
          (click)="view.set('home')"
          aria-label="Home"
        >
          <rl-icon name="house" [size]="16" />
        </button>
        <span class="wordmark">Relay</span>
        <rl-notification-popover />
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
        <div class="rail-top">
          <button
            type="button"
            class="rail-toggle"
            (click)="toggleRail()"
            [attr.aria-label]="railExpanded() ? 'Collapse sidebar' : 'Expand sidebar'"
          >
            <rl-icon name="panel-left" [size]="16" />
          </button>
          <button
            type="button"
            class="rail-item"
            [class.active]="view() === 'home'"
            (click)="view.set('home')"
            aria-label="Projects"
          >
            <span class="rail-icon"><rl-icon name="library" [size]="16" /></span>
            <span class="rail-label">Projects</span>
          </button>
          <button
            type="button"
            class="rail-item"
            [class.active]="view() === 'runtime'"
            (click)="view.set('runtime')"
            aria-label="Runtime"
          >
            <span class="rail-icon"><rl-icon name="info" [size]="16" /></span>
            <span class="rail-label">Runtime</span>
          </button>
          <button
            type="button"
            class="rail-item"
            [class.active]="view() === 'codex'"
            (click)="view.set('codex')"
            aria-label="Codex"
          >
            <span class="rail-icon"><rl-icon name="command" [size]="16" /></span>
            <span class="rail-label">Codex</span>
          </button>
        </div>

        <div class="rail-bottom">
          <button
            type="button"
            class="rail-item"
            [class.active]="view() === 'settings'"
            (click)="openSettings()"
            aria-label="Settings"
          >
            <span class="rail-icon"><rl-icon name="settings" [size]="16" /></span>
            <span class="rail-label">Settings</span>
          </button>
          <rl-app-popover surfaceRole="menu">
            <button
              type="button"
              class="rail-item account-trigger"
              rlPopoverTrigger
              aria-label="Nexus account"
              [title]="account.status().connected ? accountName() : 'Sign in with Nexus'"
            >
              <span class="rail-icon"
                ><span class="avatar" aria-hidden="true">{{ avatar() }}</span></span
              >
              <span class="rail-label">{{
                account.status().connected ? accountName() : 'Account'
              }}</span>
            </button>
            <section rlPopoverContent class="account-menu" aria-label="Nexus account">
              <p class="u-caption">Nexus account</p>
              @if (account.status().connected) {
                <p class="account-name">{{ accountName() }}</p>
                @if (account.status().email && account.status().displayName) {
                  <p class="account-email">{{ account.status().email }}</p>
                }
                <button type="button" role="menuitem" (click)="view.set('account')">
                  Account details
                </button>
                <button
                  type="button"
                  role="menuitem"
                  [disabled]="account.busy()"
                  (click)="account.logout()"
                >
                  Sign out
                </button>
                <button
                  type="button"
                  role="menuitem"
                  [disabled]="account.busy()"
                  (click)="account.logout(true)"
                >
                  Sign out everywhere
                </button>
              } @else {
                <button
                  type="button"
                  role="menuitem"
                  [disabled]="!account.available"
                  (click)="account.login()"
                >
                  Sign in with Nexus
                </button>
                @if (account.waiting()) {
                  <p class="account-email">Waiting for sign-in…</p>
                }
              }
              @if (account.error()) {
                <p class="account-error" role="alert">{{ account.error() }}</p>
              }
            </section>
          </rl-app-popover>
        </div>
      </nav>

      <main class="content">
        @if (view() === 'account') {
          <section class="account-page" aria-labelledby="account-page-title">
            <header class="account-page-header">
              <button type="button" class="account-back" (click)="view.set('home')">
                <rl-icon name="arrow-left" [size]="14" /> Back to projects
              </button>
              <p class="u-caption">PROFILE</p>
              <h1 id="account-page-title">Your account</h1>
              <p>Identity and connection details provided by Nexus.</p>
            </header>
            @if (account.status().connected) {
              <div class="account-profile-card">
                <div class="account-profile-avatar" aria-hidden="true">{{ avatar() }}</div>
                <div class="account-profile-heading">
                  <h2>{{ accountName() }}</h2>
                  <p>{{ account.status().email || 'Email unavailable' }}</p>
                </div>
                <span class="account-connected"><span></span> Connected</span>
              </div>
              <section class="account-details-card" aria-labelledby="account-details-title">
                <div class="account-details-heading">
                  <div>
                    <h2 id="account-details-title">Profile details</h2>
                    <p>Synced from your Nexus account.</p>
                  </div>
                  <rl-icon name="lock" [size]="16" />
                </div>
                <dl>
                  <div><dt>Name</dt><dd>{{ account.status().displayName || 'Not provided' }}</dd></div>
                  <div><dt>Email</dt><dd>{{ account.status().email || 'Not provided' }}</dd></div>
                  <div class="account-id-row">
                    <dt>Nexus account ID</dt>
                    <dd>{{ account.status().userId || 'Not available' }}</dd>
                  </div>
                </dl>
              </section>
              <div class="account-page-actions">
                <div>
                  <h2>Sign out of Relay</h2>
                  <p>Your Nexus account stays active on other devices.</p>
                </div>
                <button type="button" [disabled]="account.busy()" (click)="account.logout()">
                  {{ account.busy() ? 'Signing out…' : 'Sign out' }}
                </button>
              </div>
              <div class="account-page-actions">
                <div>
                  <h2>Sign out everywhere</h2>
                  <p>Ends Relay and every other app session on your Nexus account.</p>
                </div>
                <button type="button" [disabled]="account.busy()" (click)="account.logout(true)">
                  Sign out everywhere
                </button>
              </div>
              @if (account.error()) {
                <p class="account-error" role="alert">{{ account.error() }}</p>
              }
            } @else {
              <div class="account-connect-card">
                <div class="account-profile-avatar" aria-hidden="true">N</div>
                <h2>Sign in with Nexus</h2>
                <p>Sign in to see the profile details Nexus shares with Relay.</p>
                <button type="button" [disabled]="!account.available" (click)="account.login()">
                  Sign in with Nexus
                </button>
                @if (account.waiting()) {
                  <p>Waiting for sign-in in your browser…</p>
                }
                @if (account.error()) {
                  <p class="account-error" role="alert">{{ account.error() }}</p>
                }
              </div>
            }
          </section>
        } @else if (view() === 'settings') {
          <rl-settings [initialTab]="settingsTab()" />
        } @else if (view() === 'codex') {
          <rl-codex
            [openThreadId]="requestedAgentThreadId()"
            (threadHandled)="requestedAgentThreadId.set(null)"
          />
        } @else if (view() === 'vault') {
          <rl-vault />
        } @else if (view() === 'runtime') {
          <rl-runtime />
        } @else {
          <rl-projects />
        }
      </main>
    </div>

    <footer class="statusbar u-chrome">
      <rl-update-status-bar />
      <rl-background-task-indicator />
    </footer>
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
      padding-inline-start: var(--space-3);
      border-block-end: 1px solid var(--border-subtle);
      background: var(--bg-sunken);
    }

    .titlebar-start {
      display: flex;
      align-items: center;
      gap: var(--space-4);
    }

    .home-btn {
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

    .home-btn:hover {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .home-btn.active {
      color: var(--text-strong);
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
      inline-size: var(--sidebar-width-collapsed);
      padding: var(--space-3);
      border-inline-end: 1px solid var(--border-subtle);
      background: var(--bg-sunken);
      transition: inline-size var(--dur-panel) var(--ease-standard);
      overflow: visible;
    }

    .rail.expanded {
      inline-size: var(--sidebar-width);
    }

    /* Future page buttons stack here, growing downward from the top. */
    .rail-top {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      flex: 1;
      min-block-size: 0;
    }

    /* Settings stays pinned to the rail's bottom edge, apart from the rest. */
    .rail-bottom {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      flex: none;
    }

    /* A 1:1 icon button — the toggle's own shape at every rail width, and
     * a nav item's shape once the rail is narrow enough that its label is
     * gone. Fixed square dimensions rather than a stretched-to-fit row, so
     * it never reads as a wide bar with a stray icon in it. */
    .rail-toggle {
      display: grid;
      place-items: center;
      flex: none;
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

    .rail-item {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      inline-size: 100%;
      block-size: var(--control-sm);
      /* Start padding is always 0 so the icon never shifts when the rail
       * expands — only the end padding (breathing room before the label's
       * row edge) responds to that. */
      padding-inline: 0 var(--space-2);
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

    .account-trigger[aria-expanded='true'] {
      color: var(--text-strong);
      background: var(--tint-hover);
    }

    .avatar {
      display: grid;
      place-items: center;
      inline-size: 24px;
      block-size: 24px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-pill);
      background: var(--bg-app);
      font-size: var(--text-12);
      font-weight: var(--weight-semibold);
    }

    .account-menu {
      inline-size: min(260px, calc(100vw - 32px));
      padding: var(--space-2);
    }

    .account-menu p {
      margin: 0;
      padding: var(--space-2) var(--space-3);
      overflow-wrap: anywhere;
    }

    .account-name {
      color: var(--text-strong);
    }

    .account-email {
      color: var(--text-subtle);
      font-size: var(--text-12);
    }

    .account-error {
      color: var(--danger);
      font-size: var(--text-12);
    }

    .account-menu button {
      inline-size: 100%;
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-sm);
      text-align: start;
    }

    .account-menu button:hover:not(:disabled) {
      color: var(--text-strong);
      background: var(--tint-hover);
    }

    .account-menu button:disabled {
      opacity: 0.5;
    }

    .account-page {
      inline-size: min(680px, calc(100% - 40px));
      margin: clamp(24px, 7vh, 64px) auto;
    }

    .account-back {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      margin-block-end: var(--space-5);
      color: var(--text-subtle);
      font-size: var(--text-12);
    }

    .account-page-header .u-caption {
      margin: 0 0 var(--space-2);
      color: var(--accent);
    }

    .account-page-header h1 {
      margin: 0;
      color: var(--text-strong);
      font-size: clamp(26px, 4vw, 32px);
      font-weight: var(--weight-semibold);
    }

    .account-page-header > p:last-child {
      margin: var(--space-2) 0 0;
      color: var(--text-subtle);
      font-size: var(--text-12);
    }

    .account-profile-card,
    .account-details-card,
    .account-page-actions,
    .account-connect-card {
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      background: var(--bg-sunken);
    }

    .account-profile-card {
      display: flex;
      align-items: center;
      gap: var(--space-4);
      padding: var(--space-5);
    }

    .account-profile-avatar {
      display: grid;
      place-items: center;
      inline-size: 44px;
      block-size: 44px;
      flex: none;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-pill);
      color: var(--text-strong);
      background: var(--bg-overlay);
      font-size: 18px;
      font-weight: var(--weight-semibold);
    }

    .account-profile-heading {
      min-inline-size: 0;
      flex: 1;
    }

    .account-profile-heading h2,
    .account-details-heading h2,
    .account-page-actions h2,
    .account-connect-card h2 {
      margin: 0;
      color: var(--text-strong);
      font-size: var(--text-14);
      font-weight: var(--weight-semibold);
    }

    .account-profile-heading p,
    .account-details-heading p,
    .account-page-actions p,
    .account-connect-card p {
      margin: var(--space-1) 0 0;
      color: var(--text-subtle);
      font-size: var(--text-12);
      overflow-wrap: anywhere;
    }

    .account-connected {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      color: var(--text-subtle);
      font-size: var(--text-11);
    }

    .account-connected span {
      inline-size: 7px;
      block-size: 7px;
      border-radius: var(--radius-pill);
      background: var(--status-done);
    }

    .account-details-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-block-end: var(--space-3);
      border-block-end: 1px solid var(--border-subtle);
    }

    .account-details-card {
      margin-block-start: var(--space-4);
      padding: var(--space-5);
    }

    .account-details-card dl { margin: 0; }
    .account-details-card dl > div {
      display: grid;
      grid-template-columns: minmax(110px, 0.7fr) minmax(0, 1.3fr);
      gap: var(--space-3);
      padding-block: var(--space-2);
      border-block-end: 1px solid var(--border-subtle);
    }

    .account-details-card dt {
      color: var(--text-subtle);
      font-size: var(--text-12);
    }

    .account-details-card dd {
      margin: 0;
      color: var(--text-body);
      font-size: var(--text-12);
      overflow-wrap: anywhere;
    }

    .account-id-row dd {
      font-family: var(--font-mono);
      color: var(--text-muted);
    }

    .account-details-card dl > div:last-child { border: 0; }

    .account-page-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      margin-block-start: var(--space-4);
      padding: var(--space-5);
    }

    .account-page-actions button,
    .account-connect-card button {
      flex: none;
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      color: var(--text-body);
      background: var(--bg-overlay);
      font-size: var(--text-12);
    }

    .account-page-actions button:disabled,
    .account-connect-card button:disabled {
      opacity: 0.5;
    }

    .account-connect-card {
      display: grid;
      justify-items: start;
      gap: var(--space-3);
      padding: var(--space-6);
    }

    @media (max-width: 540px) {
      .account-page { inline-size: calc(100% - 32px); }
      .account-details-card dl > div { grid-template-columns: 1fr; gap: var(--space-1); }
      .account-page-actions { align-items: flex-start; flex-direction: column; }
    }

    .rail-icon {
      display: grid;
      place-items: center;
      flex: none;
      inline-size: var(--control-sm);
      block-size: var(--control-sm);
    }

    .rail-label {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
    }

    /* Collapsed: only the icon shows, as a square the same size as the
     * toggle above it — the label is removed from layout rather than just
     * clipped, so it can't skew the icon off-centre or hold onto its row's
     * width. */
    .rail:not(.expanded) .rail-item {
      inline-size: var(--control-sm);
      padding-inline: 0;
      gap: 0;
    }

    .rail:not(.expanded) .rail-label {
      display: none;
    }

    .content {
      flex: 1;
      min-inline-size: 0;
      overflow-y: auto;
    }

    .statusbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      flex: none;
      block-size: var(--statusbar-height);
      padding-inline: var(--space-3);
      border-block-start: 1px solid var(--border-subtle);
      background: var(--bg-sunken);
    }
  `,
})
export class Home {
  protected readonly account = inject(NexusAccount);
  protected readonly accountName = computed(
    () => this.account.status().displayName || this.account.status().email || 'Nexus account',
  );
  protected readonly avatar = computed(() =>
    this.account.status().connected ? this.accountName().trim().charAt(0).toLocaleUpperCase() : 'N',
  );
  protected readonly theme = inject(ThemeService);
  protected readonly view = signal<'home' | 'settings' | 'vault' | 'runtime' | 'codex' | 'account'>('home');
  protected readonly requestedAgentThreadId = signal<string | null>(null);
  /** Starts collapsed — the safe default while the persisted value (below) is
   * still loading — then reconciles with whatever the user last left it as. */
  protected readonly railExpanded = signal(false);
  protected readonly settingsTab = signal<'general' | 'github'>('general');

  private readonly tauri = inject(TauriBridge);
  protected readonly maximized = signal(false);

  constructor() {
    void this.tauri
      .getSetting<boolean>(RAIL_EXPANDED_SETTING_KEY, this.railExpanded())
      .then((stored) => this.railExpanded.set(stored));

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
        if (event.type === 'openRuntimeRequested') this.view.set('runtime');
        if (event.type === 'openAgentsRequested') this.view.set('codex');
        if (event.type === 'openAgentThreadRequested') {
          this.requestedAgentThreadId.set(event.threadId);
          this.view.set('codex');
        }
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

  protected toggleRail(): void {
    const expanded = !this.railExpanded();
    this.railExpanded.set(expanded);
    void this.tauri.setSetting(RAIL_EXPANDED_SETTING_KEY, expanded);
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
