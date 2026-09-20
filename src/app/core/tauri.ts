import { Injectable } from '@angular/core';

import type { LazyStore } from '@tauri-apps/plugin-store';

import type { AppEvent } from './events';

/**
 * The boundary between the Angular app and the Rust core.
 *
 * Every `invoke` and every event subscription the app makes goes through
 * here, so that (a) running in a plain browser during `ng serve` degrades to
 * a no-op instead of throwing, and (b) there is one place to look for the
 * full command surface.
 */
@Injectable({ providedIn: 'root' })
export class TauriBridge {
  readonly available = '__TAURI_INTERNALS__' in window;

  /** Hides the palette window without destroying it — reopening must be instant. */
  async dismissPalette(): Promise<void> {
    await this.invoke('dismiss_palette');
  }

  /**
   * Runs a command the Rust side owns. `command` mirrors
   * src-tauri/src/commands.rs's `CoreCommand` exactly — an id, and args for
   * whichever variants carry them — verified there by a test that every
   * `core_commands()` id actually deserializes into a real variant, so a
   * mismatch here fails in CI rather than silently doing nothing.
   */
  async runCoreCommand(command: CoreCommand): Promise<void> {
    await this.invoke('run_core_command', { command });
  }

  /** Requests cooperative cancellation; the job notices at its next checkpoint. */
  async cancelJob(jobId: string): Promise<void> {
    await this.invoke('cancel_job', { jobId });
  }

  /** A pull-based check alongside the push-based `notificationDone` event. */
  async isJobRunning(jobId: string): Promise<boolean> {
    return (await this.invoke<boolean>('is_job_running', { jobId })) ?? false;
  }

  /** Commands contributed by the Rust side, merged into the registry at startup. */
  async coreCommands(): Promise<readonly CoreCommandMeta[]> {
    return (await this.invoke<CoreCommandMeta[]>('core_commands')) ?? [];
  }

  /** Minimizes the current window to the taskbar/dock. */
  async minimizeWindow(): Promise<void> {
    if (!this.available) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().minimize();
  }

  /** Toggles the current window between maximized and its previous size. */
  async toggleMaximizeWindow(): Promise<void> {
    if (!this.available) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().toggleMaximize();
  }

  /** Closes the current window. On the main window this quits Relay's visible surface, not the tray process. */
  async closeWindow(): Promise<void> {
    if (!this.available) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  }

  /** Whether the current window is currently maximized. */
  async isWindowMaximized(): Promise<boolean> {
    if (!this.available) return false;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().isMaximized();
  }

  /**
   * Fires whenever the current window is resized, which includes every
   * maximize/restore toggle. Callers re-check `isWindowMaximized()` on each
   * call rather than have this report the new state itself, since Tauri's
   * event only signals that a resize happened.
   */
  async onWindowResized(handler: () => void): Promise<() => void> {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op: nothing to unsubscribe from when there is no live Tauri event system
    if (!this.available) return () => {};
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().onResized(() => handler());
  }

  /**
   * Subscribes to the core's single event channel. Returns the unlisten
   * function; callers dispose it on teardown. A no-op outside Tauri, so
   * ng serve keeps working without a live core — `handler` is simply never
   * called.
   */
  async onEvent(handler: (event: AppEvent) => void): Promise<() => void> {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op: nothing to unsubscribe from when there is no live Tauri event system
    if (!this.available) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen<AppEvent>('relay://event', (message) => handler(message.payload));
  }

  /** Opens a URL in the user's default browser. A no-op outside Tauri. */
  async openUrl(url: string): Promise<void> {
    if (!this.available) return;
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  }

  private settingsStore: LazyStore | null = null;

  /**
   * Reads a persisted setting from `settings.json` in the OS app-data
   * directory — the one real, on-disk settings store, as opposed to a
   * per-window UI preference like theme. `fallback` covers both "never set"
   * and running outside Tauri.
   */
  async getSetting<T>(key: string, fallback: T): Promise<T> {
    if (!this.available) return fallback;
    const store = await this.getSettingsStore();
    const value = await store.get<T>(key);
    return value ?? fallback;
  }

  /** Persists a setting to `settings.json`. */
  async setSetting(key: string, value: unknown): Promise<void> {
    if (!this.available) return;
    const store = await this.getSettingsStore();
    await store.set(key, value);
  }

  private async getSettingsStore(): Promise<LazyStore> {
    // A `LazyStore` only touches the filesystem on first get/set, so
    // constructing it here rather than at module load keeps this a no-op
    // outside Tauri, matching every other method on this bridge.
    this.settingsStore ??= new (await import('@tauri-apps/plugin-store')).LazyStore(
      'settings.json',
    );
    return this.settingsStore;
  }

  /** Whether Relay is registered to launch automatically at login. */
  async isAutostartEnabled(): Promise<boolean> {
    if (!this.available) return false;
    const { isEnabled } = await import('@tauri-apps/plugin-autostart');
    return isEnabled();
  }

  /** Enables or disables launching Relay automatically at login, hidden — the same as any other launch. */
  async setAutostart(enabled: boolean): Promise<void> {
    if (!this.available) return;
    const { enable, disable } = await import('@tauri-apps/plugin-autostart');
    await (enabled ? enable() : disable());
  }

  /** Whether a vault has been created, and whether it is currently unlocked. */
  async vaultStatus(): Promise<VaultStatus> {
    return (await this.invoke<VaultStatus>('vault_status')) ?? { exists: false, unlocked: false };
  }

  /** Creates a new, empty vault protected by `masterPassword`. */
  async vaultCreate(masterPassword: string): Promise<void> {
    await this.invoke('vault_create', { masterPassword });
  }

  /** Decrypts the vault into memory; throws if the password is wrong. */
  async vaultUnlock(masterPassword: string): Promise<void> {
    await this.invoke('vault_unlock', { masterPassword });
  }

  /** Drops the decrypted entries from memory. The file on disk is untouched. */
  async vaultLock(): Promise<void> {
    await this.invoke('vault_lock');
  }

  /** Generates a password from the given character-class options. */
  async generatePassword(options: PasswordOptions): Promise<string> {
    return (await this.invoke<string>('generate_password', { options })) ?? '';
  }

  /** Adds a new entry to the unlocked vault and persists it immediately. */
  async vaultAddEntry(entry: NewVaultEntry): Promise<VaultEntrySummary | null> {
    return this.invoke<VaultEntrySummary>('vault_add_entry', { entry });
  }

  /** Lists every entry in the unlocked vault, without passwords. */
  async vaultListEntries(): Promise<readonly VaultEntrySummary[]> {
    return (await this.invoke<VaultEntrySummary[]>('vault_list_entries')) ?? [];
  }

  /** Reveals one entry's password by id. */
  async vaultRevealPassword(id: string): Promise<string> {
    return (await this.invoke<string>('vault_reveal_password', { id })) ?? '';
  }

  /** Removes an entry from the unlocked vault and persists the change. */
  async vaultDeleteEntry(id: string): Promise<void> {
    await this.invoke('vault_delete_entry', { id });
  }

  /** Writes an encrypted copy of the vault to disk and returns the path. */
  async vaultExport(): Promise<string> {
    return (await this.invoke<string>('vault_export')) ?? '';
  }

  /** Whether a GitHub account is connected. Only reads the keychain. */
  async githubStatus(): Promise<GithubStatus> {
    return (
      (await this.invoke<GithubStatus>('github_status')) ?? { connected: false, username: null }
    );
  }

  /**
   * Starts a Device Flow login and returns the code to show the user. The
   * wait for their approval continues in a background job — `jobId` lets the
   * caller correlate `notificationDone` for that job with this attempt.
   */
  async githubConnectStart(): Promise<DeviceAuthorization | null> {
    return this.invoke<DeviceAuthorization>('github_connect_start');
  }

  /** Disconnects the GitHub account and stops the poll job, if running. */
  async githubDisconnect(): Promise<void> {
    await this.invoke('github_disconnect');
  }

  /** Reads the connector's rules and poll interval from `settings.json`. */
  async githubSettings(): Promise<GithubConnectorSettings> {
    return this.getSetting<GithubConnectorSettings>('github.settings', DEFAULT_GITHUB_SETTINGS);
  }

  /** Persists the connector's rules and poll interval to `settings.json`. */
  async setGithubSettings(settings: GithubConnectorSettings): Promise<void> {
    await this.setSetting('github.settings', settings);
  }

  private async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T | null> {
    if (!this.available) {
      console.info(`[relay] invoke(${command}) skipped — not running under Tauri`, args);
      return null;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
  }
}

/** Mirrors src-tauri/src/commands.rs's `CoreCommand`. */
export type CoreCommand =
  | { readonly id: 'open_settings' }
  | { readonly id: 'open_main' }
  | { readonly id: 'hide_hud' }
  | { readonly id: 'open_vault' }
  | { readonly id: 'open_github' }
  | { readonly id: 'quit' };

/** What the palette displays for a core-contributed row. Mirrors `CoreCommandMeta`. */
export interface CoreCommandMeta {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  readonly hint?: string;
  readonly icon?: string;
}

/** Mirrors `vault::VaultStatus`. */
export interface VaultStatus {
  readonly exists: boolean;
  readonly unlocked: boolean;
}

/** Mirrors `vault::VaultEntrySummary` — every field but the password. */
export interface VaultEntrySummary {
  readonly id: string;
  readonly label: string;
  readonly username: string;
  readonly url?: string;
  readonly notes?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Mirrors `vault::NewVaultEntry`. */
export interface NewVaultEntry {
  readonly label: string;
  readonly username: string;
  readonly password: string;
  readonly url?: string;
  readonly notes?: string;
}

/** Mirrors `vault::PasswordOptions`. */
export interface PasswordOptions {
  readonly length: number;
  readonly upper: boolean;
  readonly lower: boolean;
  readonly digits: boolean;
  readonly symbols: boolean;
}

/** Mirrors `github::GithubStatus`. */
export interface GithubStatus {
  readonly connected: boolean;
  readonly username: string | null;
}

/** Mirrors `github::oauth::DeviceAuthorization`. */
export interface DeviceAuthorization {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly jobId: string;
}

/** Mirrors `github::rules::PrEventKind`. */
export type PrEventKind =
  'opened' | 'closed' | 'merged' | 'review_requested' | 'ci_failed' | 'ci_passed';

/** All six, in the order the settings UI lists them. */
export const PR_EVENT_KINDS: readonly PrEventKind[] = [
  'opened',
  'closed',
  'merged',
  'review_requested',
  'ci_failed',
  'ci_passed',
];

/** Mirrors `github::rules::NotificationTypeRule`. */
export interface NotificationTypeRule {
  readonly enabled: boolean;
  readonly repoPattern: string;
  readonly branchInclude: readonly string[];
  readonly branchExclude: readonly string[];
}

/** Mirrors `github::rules::NotificationSettings` — one rule per `PrEventKind`. */
export interface NotificationSettings {
  readonly opened: NotificationTypeRule;
  readonly closed: NotificationTypeRule;
  readonly merged: NotificationTypeRule;
  readonly reviewRequested: NotificationTypeRule;
  readonly ciFailed: NotificationTypeRule;
  readonly ciPassed: NotificationTypeRule;
}

/** Reads the rule for one kind out of `NotificationSettings` — mirrors `NotificationSettings::rule_for`. */
export function ruleFor(
  notifications: NotificationSettings,
  kind: PrEventKind,
): NotificationTypeRule {
  switch (kind) {
    case 'opened':
      return notifications.opened;
    case 'closed':
      return notifications.closed;
    case 'merged':
      return notifications.merged;
    case 'review_requested':
      return notifications.reviewRequested;
    case 'ci_failed':
      return notifications.ciFailed;
    case 'ci_passed':
      return notifications.ciPassed;
  }
}

/** Mirrors `github::rules::GithubConnectorSettings`. */
export interface GithubConnectorSettings {
  readonly pollIntervalSecs: number;
  readonly notifications: NotificationSettings;
  readonly muted: readonly string[];
  /** A GitHub OAuth App (Device Flow enabled) client id. `null` until configured. */
  readonly clientId: string | null;
}

const DISABLED_RULE: NotificationTypeRule = {
  enabled: false,
  repoPattern: '*',
  branchInclude: [],
  branchExclude: [],
};

function enabledRule(repoPattern: string): NotificationTypeRule {
  return { enabled: true, repoPattern, branchInclude: [], branchExclude: [] };
}

/** Mirrors `GithubConnectorSettings::default()` in `github::rules`. */
export const DEFAULT_GITHUB_SETTINGS: GithubConnectorSettings = {
  pollIntervalSecs: 300,
  notifications: {
    opened: enabledRule('*'),
    closed: DISABLED_RULE,
    merged: enabledRule('*'),
    reviewRequested: enabledRule('*'),
    ciFailed: enabledRule('*'),
    ciPassed: DISABLED_RULE,
  },
  muted: [],
  clientId: null,
};
