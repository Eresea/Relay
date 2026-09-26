import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  viewChild,
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
import { AgentThreads } from '@features/agents/agent-threads';
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
    AgentThreads,
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
            [class.active]="view() === 'agents'"
            (click)="view.set('agents')"
            aria-label="Agent threads"
          >
            <span class="rail-icon"><rl-icon name="bot" [size]="16" /></span>
            <span class="rail-label">Agent threads</span>
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
              [title]="account.status().connected ? accountName() : 'Connect through Nexus'"
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
                <button
                  type="button"
                  role="menuitem"
                  [disabled]="account.busy()"
                  (click)="account.logout()"
                >
                  Sign out
                </button>
              } @else {
                <button
                  type="button"
                  role="menuitem"
                  [disabled]="account.busy() || !account.available"
                  (click)="openNexusDialog()"
                >
                  Connect through Nexus
                </button>
              }
              @if (account.error()) {
                <p class="account-error" role="alert">{{ account.error() }}</p>
              }
            </section>
          </rl-app-popover>
        </div>
      </nav>

      @if (accountDialogOpen()) {
          <dialog
            #accountDialog
            class="account-dialog"
            aria-labelledby="account-dialog-title"
            (click)="onAccountDialogClick($event)"
            (cancel)="closeNexusDialog()"
          >
            <header class="account-dialog-heading">
              <div>
                <p class="u-caption">Nexus account</p>
                <h2 id="account-dialog-title">{{ authDialogTitle() }}</h2>
              </div>
              <button
                type="button"
                class="account-dialog-close"
                aria-label="Close sign-in"
                (click)="closeNexusDialog()"
              >
                <rl-icon name="x" [size]="16" />
              </button>
            </header>
            @if (account.error()) {
              <p class="account-dialog-error" role="alert">{{ account.error() }}</p>
            }
            @switch (authView()) {
              @case ('social') {
                <div class="account-dialog-options">
                  <button
                    class="account-dialog-google"
                    type="button"
                    [disabled]="account.busy()"
                    (click)="account.googleLogin()"
                  >
                    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.66l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                    </svg>
                    {{ account.busy() ? 'Waiting for Google…' : 'Continue with Google' }}
                  </button>
                  <p class="account-dialog-hint">Google opens in your browser, then returns you to Relay.</p>
                  <div class="account-dialog-divider">or</div>
                  <button class="account-dialog-secondary" type="button" (click)="setAuthView('email')">
                    Use email address
                  </button>
                </div>
              }
              @case ('email') {
                <form (submit)="submitNexusLogin($event)">
                  <label for="nexus-email">Email</label>
                  <input
                    id="nexus-email"
                    name="email"
                    type="email"
                    autocomplete="username"
                    required
                    autofocus
                    [value]="authEmail()"
                    (input)="authEmail.set($any($event.target).value)"
                  />
                  <label for="nexus-password">Password</label>
                  <input
                    id="nexus-password"
                    name="password"
                    type="password"
                    autocomplete="current-password"
                    required
                    [value]="authPassword()"
                    (input)="authPassword.set($any($event.target).value)"
                  />
                  <button class="account-dialog-submit" type="submit" [disabled]="account.busy()">
                    {{ account.busy() ? 'Signing in…' : 'Sign in' }}
                  </button>
                  <button class="account-dialog-secondary" type="button" (click)="setAuthView('create')">
                    Create account
                  </button>
                  <button class="account-dialog-back" type="button" (click)="setAuthView('social')">
                    Go back
                  </button>
                </form>
              }
              @case ('create') {
                <form (submit)="submitNexusRegister($event)">
                  <label for="nexus-display-name">Name</label>
                  <input
                    id="nexus-display-name"
                    name="displayName"
                    autocomplete="name"
                    required
                    [value]="authDisplayName()"
                    (input)="authDisplayName.set($any($event.target).value)"
                  />
                  <label for="nexus-create-email">Email</label>
                  <input
                    id="nexus-create-email"
                    name="email"
                    type="email"
                    autocomplete="email"
                    required
                    [value]="authEmail()"
                    (input)="authEmail.set($any($event.target).value)"
                  />
                  <label for="nexus-create-password">Password</label>
                  <input
                    id="nexus-create-password"
                    name="password"
                    type="password"
                    autocomplete="new-password"
                    minlength="8"
                    required
                    [value]="authPassword()"
                    (input)="authPassword.set($any($event.target).value)"
                  />
                  <p class="account-dialog-hint">Use at least 8 characters.</p>
                  <label for="nexus-confirm-password">Confirm password</label>
                  <input
                    id="nexus-confirm-password"
                    name="confirmPassword"
                    type="password"
                    autocomplete="new-password"
                    required
                    [value]="authPasswordConfirm()"
                    (input)="authPasswordConfirm.set($any($event.target).value)"
                  />
                  @if (authPasswordConfirm() && authPassword() !== authPasswordConfirm()) {
                    <p class="account-dialog-hint">Passwords do not match.</p>
                  }
                  <button
                    class="account-dialog-submit"
                    type="submit"
                    [disabled]="account.busy() || authPassword().length < 8 || authPassword() !== authPasswordConfirm()"
                  >
                    {{ account.busy() ? 'Creating account…' : 'Create account' }}
                  </button>
                  <button class="account-dialog-back" type="button" (click)="setAuthView('email')">
                    Go back
                  </button>
                </form>
              }
              @case ('verify-email') {
                <form (submit)="submitNexusEmailVerification($event)">
                  <p class="account-dialog-hint">
                    Enter the verification token sent to {{ authEmail() }}.
                  </p>
                  <label for="nexus-verification-token">Email verification token</label>
                  <input
                    id="nexus-verification-token"
                    name="token"
                    autocomplete="one-time-code"
                    required
                    autofocus
                    [value]="emailVerificationToken()"
                    (input)="emailVerificationToken.set($any($event.target).value)"
                  />
                  <button class="account-dialog-submit" type="submit" [disabled]="account.busy()">
                    {{ account.busy() ? 'Verifying…' : 'Verify and connect' }}
                  </button>
                  <button class="account-dialog-back" type="button" (click)="setAuthView('email')">
                    Go back
                  </button>
                </form>
              }
              @case ('mfa') {
                <form (submit)="submitNexusMfa($event)">
                  <p class="account-dialog-hint">Continue with one of your sign-in checks.</p>
                  <label for="nexus-mfa-code">Authenticator code</label>
                  <input
                    id="nexus-mfa-code"
                    name="code"
                    autocomplete="one-time-code"
                    [value]="mfaCode()"
                    (input)="mfaCode.set($any($event.target).value)"
                    autofocus
                  />
                  <label for="nexus-recovery-code">Recovery code</label>
                  <input
                    id="nexus-recovery-code"
                    name="recoveryCode"
                    autocomplete="off"
                    [value]="recoveryCode()"
                    (input)="recoveryCode.set($any($event.target).value)"
                  />
                  <button class="account-dialog-submit" type="submit" [disabled]="account.busy()">
                    {{ account.busy() ? 'Verifying…' : 'Verify identity' }}
                  </button>
                  <button class="account-dialog-back" type="button" (click)="cancelMfa()">
                    Cancel
                  </button>
                </form>
              }
            }
          </dialog>
      }

      <main class="content">
        @if (view() === 'settings') {
          <rl-settings [initialTab]="settingsTab()" />
        } @else if (view() === 'codex') {
          <rl-codex />
        } @else if (view() === 'vault') {
          <rl-vault />
        } @else if (view() === 'runtime') {
          <rl-runtime />
        } @else if (view() === 'agents') {
          <rl-agent-threads
            [openThreadId]="requestedAgentThreadId()"
            (threadHandled)="requestedAgentThreadId.set(null)"
          />
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

    .account-dialog {
      inline-size: min(420px, calc(100% - 32px));
      max-block-size: calc(100dvh - 32px);
      margin: auto;
      overflow-y: auto;
      padding: var(--space-5);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      background: var(--bg-overlay);
      box-shadow: var(--shadow-lg);
    }

    .account-dialog::backdrop {
      background: rgb(0 0 0 / 55%);
    }

    .account-dialog-heading {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: var(--space-4);
      margin-block-end: var(--space-5);
    }

    .account-dialog-heading p,
    .account-dialog-heading h2 {
      margin: 0;
    }

    .account-dialog-heading h2 {
      margin-block-start: var(--space-1);
      color: var(--text-strong);
      font-size: var(--text-18);
    }

    .account-dialog-close {
      display: grid;
      place-items: center;
      inline-size: 32px;
      block-size: 32px;
      border-radius: var(--radius-sm);
    }

    .account-dialog form {
      display: grid;
      gap: var(--space-2);
    }

    .account-dialog-options {
      display: grid;
      gap: var(--space-3);
    }

    .account-dialog-divider {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      color: var(--text-subtle);
      font-size: var(--text-12);
      font-weight: var(--weight-semibold);
      text-transform: uppercase;
    }

    .account-dialog-divider::before,
    .account-dialog-divider::after {
      flex: 1;
      block-size: 1px;
      background: var(--border-subtle);
      content: '';
    }

    .account-dialog label {
      margin-block-start: var(--space-2);
      color: var(--text-subtle);
      font-size: var(--text-12);
    }

    .account-dialog input {
      inline-size: 100%;
      min-block-size: 40px;
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      background: var(--bg-app);
      color: var(--text-strong);
    }

    .account-dialog-hint,
    .account-error,
    .account-dialog-error {
      margin: var(--space-1) 0;
      color: var(--danger);
      font-size: var(--text-12);
    }

    .account-dialog-error {
      padding: var(--space-3);
      border: 1px solid color-mix(in srgb, var(--danger) 24%, transparent);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--danger) 8%, transparent);
    }

    .account-dialog-hint {
      color: var(--text-subtle);
    }

    .account-dialog-submit {
      min-block-size: 40px;
      margin-block-start: var(--space-3);
      padding-inline: var(--space-3);
      border-radius: var(--radius-sm);
      background: var(--accent);
      color: var(--text-body);
      font-weight: var(--weight-semibold);
    }

    .account-dialog-submit:disabled {
      opacity: 0.6;
    }

    .account-dialog-google {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-3);
      min-block-size: 40px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      background: var(--bg-sunken);
      color: var(--text-body);
    }

    .account-dialog-secondary {
      min-block-size: 40px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      background: var(--bg-sunken);
      color: var(--text-body);
    }

    .account-dialog-back {
      min-block-size: 36px;
      color: var(--text-subtle);
    }

    .account-dialog-google:disabled,
    .account-dialog-secondary:disabled,
    .account-dialog-back:disabled {
      opacity: 0.6;
    }

    @media (max-width: 700px) {
      .account-dialog {
        inline-size: 100%;
        max-block-size: 90dvh;
        margin: 0;
        padding: var(--space-5) var(--space-4) max(var(--space-5), env(safe-area-inset-bottom));
        border-radius: var(--radius-lg) var(--radius-lg) 0 0;
        position: fixed;
        inset-block: auto 0;
      }
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
  protected readonly accountDialogOpen = signal(false);
  protected readonly account = inject(NexusAccount);
  protected readonly authView = signal<'social' | 'email' | 'create' | 'verify-email' | 'mfa'>('social');
  protected readonly authEmail = signal('');
  protected readonly authPassword = signal('');
  protected readonly authPasswordConfirm = signal('');
  protected readonly authDisplayName = signal('');
  protected readonly emailVerificationToken = signal('');
  protected readonly mfaCode = signal('');
  protected readonly recoveryCode = signal('');
  protected readonly authDialogTitle = computed(() => {
    switch (this.authView()) {
      case 'social': return 'Connect through Nexus';
      case 'email': return 'Sign in with email';
      case 'create': return 'Create your account';
      case 'verify-email': return 'Verify your email';
      case 'mfa': return 'Verify it’s you';
      default: return 'Connect through Nexus';
    }
  });
  protected readonly accountName = computed(
    () => this.account.status().displayName || this.account.status().email || 'Nexus account',
  );
  protected readonly avatar = computed(() =>
    this.account.status().connected ? this.accountName().trim().charAt(0).toLocaleUpperCase() : 'N',
  );
  protected readonly theme = inject(ThemeService);
  protected readonly view = signal<'home' | 'settings' | 'vault' | 'runtime' | 'agents' | 'codex'>(
    'home',
  );
  protected readonly requestedAgentThreadId = signal<string | null>(null);
  /** Starts collapsed — the safe default while the persisted value (below) is
   * still loading — then reconciles with whatever the user last left it as. */
  protected readonly railExpanded = signal(false);
  protected readonly settingsTab = signal<'general' | 'github'>('general');

  private readonly tauri = inject(TauriBridge);
  protected readonly maximized = signal(false);
  private readonly accountDialogElement = viewChild<ElementRef<HTMLDialogElement>>('accountDialog');

  protected openNexusDialog(): void {
    this.authView.set('social');
    this.account.error.set('');
    this.accountDialogOpen.set(true);
  }

  protected closeNexusDialog(): void {
    const dialog = this.accountDialogElement()?.nativeElement;
    if (dialog?.open) dialog.close();
    this.accountDialogOpen.set(false);
    this.authView.set('social');
    this.authPassword.set('');
    this.authPasswordConfirm.set('');
    this.authDisplayName.set('');
    this.emailVerificationToken.set('');
    this.mfaCode.set('');
    this.recoveryCode.set('');
    this.account.error.set('');
  }

  protected onAccountDialogClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closeNexusDialog();
  }

  protected setAuthView(view: 'social' | 'email' | 'create' | 'verify-email' | 'mfa'): void {
    this.account.error.set('');
    this.authView.set(view);
  }

  protected async submitNexusLogin(event: Event): Promise<void> {
    event.preventDefault();
    await this.account.login(this.authEmail(), this.authPassword());
    if (this.account.mfaRequired()) this.setAuthView('mfa');
    if (this.account.status().connected) this.closeNexusDialog();
  }

  protected async submitNexusRegister(event: Event): Promise<void> {
    event.preventDefault();
    if (this.authPassword() !== this.authPasswordConfirm()) return;
    if (await this.account.register(this.authEmail(), this.authPassword(), this.authDisplayName())) {
      this.emailVerificationToken.set('');
      this.setAuthView('verify-email');
    }
  }

  protected async submitNexusEmailVerification(event: Event): Promise<void> {
    event.preventDefault();
    if (!(await this.account.verifyEmail(this.emailVerificationToken()))) return;
    this.setAuthView('email');
    await this.account.login(this.authEmail(), this.authPassword());
    if (this.account.mfaRequired()) this.setAuthView('mfa');
    if (this.account.status().connected) this.closeNexusDialog();
  }

  protected async submitNexusMfa(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.mfaCode().trim() && !this.recoveryCode().trim()) {
      this.account.error.set('Enter an authenticator code or a recovery code.');
      return;
    }
    await this.account.verifyMfa(this.mfaCode(), this.recoveryCode());
    this.mfaCode.set('');
    this.recoveryCode.set('');
    if (this.account.status().connected) this.closeNexusDialog();
    else this.setAuthView('email');
  }

  protected cancelMfa(): void {
    this.account.mfaRequired.set(false);
    this.mfaCode.set('');
    this.recoveryCode.set('');
    this.setAuthView('email');
  }

  constructor() {
    afterRenderEffect(() => {
      const dialog = this.accountDialogElement()?.nativeElement;
      if (this.accountDialogOpen() && dialog && !dialog.open) dialog.showModal();
    });
    effect(() => {
      if (this.accountDialogOpen() && this.account.status().connected) this.closeNexusDialog();
    });
    effect(() => {
      if (this.account.mfaRequired()) {
        this.authView.set('mfa');
        this.accountDialogOpen.set(true);
      }
    });

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
        if (event.type === 'openAgentsRequested') this.view.set('agents');
        if (event.type === 'openAgentThreadRequested') {
          this.requestedAgentThreadId.set(event.threadId);
          this.view.set('agents');
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
