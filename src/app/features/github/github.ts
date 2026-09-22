import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  DEFAULT_GITHUB_SETTINGS,
  PR_EVENT_KINDS,
  TauriBridge,
  ruleFor,
  type DeviceAuthorization,
  type GithubConnectorSettings,
  type GithubStatus,
  type NotificationSettings,
  type NotificationTypeRule,
  type PrEventKind,
} from '@core/tauri';
import { Icon } from '@shared/icon';

const KIND_LABELS: Readonly<Record<PrEventKind, string>> = {
  opened: 'Opened',
  closed: 'Closed',
  merged: 'Merged',
  review_requested: 'Review requested',
  ci_failed: 'CI failed',
  ci_passed: 'CI passed',
};

/** A `NotificationTypeRule` with its glob lists as comma-separated text, for binding to a single field. */
interface EditableTypeRule {
  enabled: boolean;
  repoPattern: string;
  branchInclude: string;
  branchExclude: string;
}

type EditableNotifications = Record<PrEventKind, EditableTypeRule>;

function toEditableRule(rule: NotificationTypeRule): EditableTypeRule {
  return {
    enabled: rule.enabled,
    repoPattern: rule.repoPattern,
    branchInclude: rule.branchInclude.join(', '),
    branchExclude: rule.branchExclude.join(', '),
  };
}

function fromEditableRule(rule: EditableTypeRule): NotificationTypeRule {
  return {
    enabled: rule.enabled,
    repoPattern: rule.repoPattern.trim() || '*',
    branchInclude: splitList(rule.branchInclude),
    branchExclude: splitList(rule.branchExclude),
  };
}

function toEditableNotifications(notifications: NotificationSettings): EditableNotifications {
  return Object.fromEntries(
    PR_EVENT_KINDS.map((kind) => [kind, toEditableRule(ruleFor(notifications, kind))]),
  ) as EditableNotifications;
}

function fromEditableNotifications(notifications: EditableNotifications): NotificationSettings {
  return {
    opened: fromEditableRule(notifications.opened),
    closed: fromEditableRule(notifications.closed),
    merged: fromEditableRule(notifications.merged),
    reviewRequested: fromEditableRule(notifications.review_requested),
    ciFailed: fromEditableRule(notifications.ci_failed),
    ciPassed: fromEditableRule(notifications.ci_passed),
  };
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * `invoke` rejects with whatever `src-tauri/src/error.rs`'s `Error` serializes
 * to — a plain string, per its `Serialize` impl — so a command failure (a
 * placeholder OAuth client id, no network, GitHub down) surfaces here as a
 * string rather than an `Error` instance.
 */
function connectorErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return 'Could not start GitHub sign-in.';
}

/**
 * The GitHub connector: connect an account over Device Flow, then configure
 * which pull request activity is worth a notification, one switch per kind
 * of event. The poll job itself lives entirely core-side
 * (`src-tauri/src/github`); this component only ever shows connection
 * status and edits `settings.json` — it never talks to GitHub directly.
 *
 * Rendered inside the Settings page's "GitHub" tab (`settings.ts`), which
 * keeps this component mounted rather than destroying it when another tab
 * is selected — the Device Flow wait spans several seconds to minutes, and
 * losing this component's listener mid-wait would lose the transition to
 * "connected" along with it.
 */
@Component({
  selector: 'rl-github',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Icon],
  template: `
    <section class="wrap">
      @switch (status()) {
        @case ('disconnected') {
          <div class="connect">
            <rl-icon name="inbox" [size]="20" />
            <p class="u-title">Connect GitHub</p>
            <p class="hint">
              Relay polls the signed-in account's pull requests and notifies you about the activity
              your settings ask for — new PRs, reviews requested, and CI results.
            </p>

            <div class="client-id-setup">
              <p class="hint">
                Needs a GitHub OAuth App with Device Flow enabled. Create one, then paste its client
                id below.
              </p>
              <button type="button" class="link" (click)="openDeveloperSettings()">
                Open GitHub Developer Settings
              </button>
              <input
                class="field"
                placeholder="OAuth App client id"
                [(ngModel)]="clientId"
                (change)="save()"
              />
            </div>

            <button
              type="button"
              class="primary"
              [disabled]="busy() || !clientId().trim()"
              (click)="connect()"
            >
              Connect
            </button>
            @if (error()) {
              <p class="error">{{ error() }}</p>
            }
          </div>
        }
        @case ('connecting') {
          @if (deviceAuth(); as auth) {
            <div class="connect">
              <rl-icon name="inbox" [size]="20" />
              <p class="u-title">Enter this code on GitHub</p>
              <code class="user-code">{{ auth.userCode }}</code>
              <p class="hint">{{ auth.verificationUri }}</p>
              <div class="connect-actions">
                <button type="button" class="primary" (click)="openVerification(auth)">
                  Open on GitHub
                </button>
                <button
                  type="button"
                  class="link"
                  (click)="copyCode(auth)"
                  [attr.aria-label]="codeCopied() ? 'Copied user code' : 'Copy user code'"
                >
                  {{ codeCopied() ? 'Copied!' : 'Copy code' }}
                </button>
              </div>
              <button type="button" class="link" (click)="cancelConnect(auth)">Cancel</button>
              @if (error()) {
                <p class="error">{{ error() }}</p>
              }
            </div>
          }
        }
        @case ('connected') {
          <section class="group">
            <div class="row-header">
              <h2 class="u-caption">Account</h2>
              <button type="button" class="link" (click)="disconnect()">Disconnect</button>
            </div>
            <div class="row">
              <div class="account-status">
                <span class="status-dot"></span>
                <p class="label">
                  Connected as <strong>{{ username() }}</strong>
                </p>
              </div>
            </div>
          </section>

          <section class="group">
            <h2 class="u-caption">Polling</h2>
            <div class="row">
              <div>
                <p class="label">Check every</p>
                <p class="hint">A minimum of 60 seconds is always enforced.</p>
              </div>
              <label class="option">
                <input
                  type="number"
                  min="60"
                  [(ngModel)]="pollIntervalSecs"
                  (ngModelChange)="save()"
                />
                <span>seconds</span>
              </label>
            </div>
          </section>

          <section class="group">
            <h2 class="u-caption">Notifications</h2>
            <p class="hint notifications-hint">
              One switch per kind of activity. Scope any of them to specific repos or branches —
              empty branch fields mean every branch.
            </p>

            @for (kind of kinds; track kind) {
              @let rule = notifications()[kind];
              <div class="rule" [class.rule-disabled]="!rule.enabled">
                <div class="rule-header">
                  <button
                    type="button"
                    role="switch"
                    class="switch"
                    [attr.aria-checked]="rule.enabled"
                    (click)="toggleKind(kind)"
                  >
                    <span class="switch-thumb"></span>
                  </button>
                  <p class="label kind-label">{{ kindLabel(kind) }}</p>
                </div>

                <div class="rule-fields">
                  <input
                    class="field"
                    placeholder="Repo pattern, e.g. my-org/*"
                    [(ngModel)]="rule.repoPattern"
                    (change)="save()"
                  />
                  <input
                    class="field"
                    placeholder="Branches to include (comma-separated globs, empty = all)"
                    [(ngModel)]="rule.branchInclude"
                    (change)="save()"
                  />
                  <input
                    class="field"
                    placeholder="Branches to exclude"
                    [(ngModel)]="rule.branchExclude"
                    (change)="save()"
                  />
                </div>
              </div>
            }
          </section>

          <section class="group">
            <h2 class="u-caption">Muted</h2>
            <p class="hint">
              Exact exceptions: a repo (<code>owner/repo</code>), a branch
              (<code>owner/repo&#64;branch</code>), or one pull request
              (<code>owner/repo#123</code>).
            </p>

            @if (muted().length === 0) {
              <p class="hint">Nothing muted.</p>
            } @else {
              @for (key of muted(); track key) {
                <div class="entry">
                  <code class="mute-key">{{ key }}</code>
                  <button
                    type="button"
                    class="icon-btn danger"
                    (click)="removeMute(key)"
                    aria-label="Remove mute"
                  >
                    <rl-icon name="trash-2" [size]="16" />
                  </button>
                </div>
              }
            }

            <form class="mute-form" (ngSubmit)="addMute()">
              <input class="field" placeholder="owner/repo" [(ngModel)]="newMuteKey" name="mute" />
              <button type="submit" class="link" [disabled]="!newMuteKey().trim()">Mute</button>
            </form>
          </section>
        }
        @default {
          <p class="hint loading">Loading…</p>
        }
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      inline-size: 100%;
      max-inline-size: var(--content-max);
      margin-inline: auto;
      padding-block-start: var(--space-6);
    }

    .loading {
      text-align: center;
      margin-block-start: var(--space-10);
    }

    .group + .group {
      margin-block-start: var(--space-8);
    }

    .group h2 {
      margin: 0 0 var(--space-4);
    }

    .notifications-hint {
      margin-block-start: calc(var(--space-4) * -1);
      margin-block-end: var(--space-4);
    }

    .row-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-block-end: var(--space-4);
    }

    .row-header h2 {
      margin: 0;
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

    .account-status {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    .status-dot {
      inline-size: 8px;
      block-size: 8px;
      border-radius: var(--radius-pill);
      background: var(--status-done);
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

    .option {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--text-13);
      color: var(--text-muted);
    }

    .option input {
      inline-size: 5.5em;
      padding: var(--space-2) var(--space-3);
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      color: var(--text-body);
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

    .link:disabled {
      opacity: 0.5;
    }

    .primary {
      padding: var(--space-3) var(--space-5);
      font-size: var(--text-13);
      font-weight: var(--weight-semibold);
      color: var(--bg-app);
      background: var(--accent);
      border-radius: var(--radius-sm);
    }

    .primary:disabled {
      opacity: 0.5;
    }

    .field {
      padding: var(--space-3) var(--space-4);
      font-size: var(--text-13);
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      color: var(--text-body);
    }

    .connect {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-3);
      max-inline-size: 26em;
      margin: var(--space-10) auto 0;
      text-align: center;
    }

    .connect-actions {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .client-id-setup {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-2);
      inline-size: 100%;
      padding: var(--space-4);
      background: var(--bg-sunken);
      border-radius: var(--radius-sm);
    }

    .client-id-setup .field {
      inline-size: 100%;
    }

    .user-code {
      padding: var(--space-3) var(--space-5);
      font-size: var(--text-16);
      letter-spacing: 0.1em;
      background: var(--bg-sunken);
      border-radius: var(--radius-sm);
    }

    .error {
      margin: 0;
      font-size: var(--text-12);
      color: var(--danger-ink);
    }

    .rule {
      padding: var(--space-4) 0;
      border-block-end: 1px solid var(--border-subtle);
      transition: opacity var(--dur-hover) var(--ease-standard);
    }

    .rule.rule-disabled {
      opacity: 0.6;
    }

    .rule:last-child {
      border-block-end: none;
    }

    .rule-header {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      margin-block-end: var(--space-3);
    }

    .kind-label {
      font-weight: var(--weight-semibold);
    }

    .rule-fields {
      display: flex;
      gap: var(--space-3);
    }

    .rule-fields .field {
      flex: 1;
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

    .icon-btn {
      display: grid;
      place-items: center;
      inline-size: var(--control-sm);
      block-size: var(--control-sm);
      color: var(--text-subtle);
      border-radius: var(--radius-sm);
    }

    .icon-btn:hover {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .icon-btn.danger:hover {
      color: var(--danger-ink);
      background: var(--danger);
    }

    .entry {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      padding: var(--space-3) 0;
      border-block-end: 1px solid var(--border-subtle);
    }

    .mute-key {
      font-size: var(--text-12);
      color: var(--text-muted);
    }

    .mute-form {
      display: flex;
      gap: var(--space-2);
      margin-block-start: var(--space-4);
    }

    .mute-form .field {
      flex: 1;
    }
  `,
})
export class Github {
  private readonly tauri = inject(TauriBridge);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly kinds = PR_EVENT_KINDS;

  protected readonly status = signal<'loading' | 'disconnected' | 'connecting' | 'connected'>(
    'loading',
  );
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly username = signal<string | null>(null);
  protected readonly deviceAuth = signal<DeviceAuthorization | null>(null);
  /** The most recent "blocked" detail reported for the in-flight connect job, if any — the real
   * reason a connection attempt failed, shown in place of a generic message when it is available. */
  private blockedMessage = '';
  /**
   * A pull-based check alongside the push-based event handling below, for
   * the same reason `is_job_running` exists as a command at all: if the
   * `notificationDone` event is ever missed or misdelivered — a dropped
   * event, a listener registered a moment too late — the "connecting"
   * screen would otherwise wait forever even though the connection quietly
   * succeeded or failed. This polls the real, authoritative state directly
   * instead of trusting the event alone.
   */
  private connectFallbackPoll: ReturnType<typeof setInterval> | null = null;

  protected readonly clientId = signal('');
  protected readonly pollIntervalSecs = signal(DEFAULT_GITHUB_SETTINGS.pollIntervalSecs);
  protected readonly notifications = signal<EditableNotifications>(
    toEditableNotifications(DEFAULT_GITHUB_SETTINGS.notifications),
  );
  protected readonly muted = signal<string[]>([]);
  protected readonly newMuteKey = signal('');

  protected readonly codeCopied = signal(false);
  private copyCodeTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.refreshStatus();

    console.log('[github] component constructed, subscribing to relay://event');
    void this.tauri
      .onEvent((event) => {
        console.log('[github] event received', event, {
          jobId: this.deviceAuth()?.jobId,
          status: this.status(),
        });
        const jobId = this.deviceAuth()?.jobId;
        if (!jobId || this.status() !== 'connecting') return;

        if (event.type === 'notification' && event.jobId === jobId && event.status === 'blocked') {
          this.blockedMessage = event.detail ? `${event.title}: ${event.detail}` : event.title;
        }
        if (event.type === 'notificationDone' && event.jobId === jobId) {
          this.stopConnectFallbackPoll();
          if (event.ok) {
            void this.refreshStatus();
          } else {
            this.error.set(this.blockedMessage || 'Could not connect to GitHub.');
            this.status.set('disconnected');
            this.deviceAuth.set(null);
          }
        }
      })
      .then((unlisten) => {
        console.log('[github] event subscription active');
        this.destroyRef.onDestroy(unlisten);
      });

    this.destroyRef.onDestroy(() => {
      this.stopConnectFallbackPoll();
      if (this.copyCodeTimeout) clearTimeout(this.copyCodeTimeout);
    });
  }

  private startConnectFallbackPoll(jobId: string): void {
    this.stopConnectFallbackPoll();
    this.notConnectedAfterJobEndedStreak = 0;
    this.connectFallbackPoll = setInterval(() => void this.pollConnectFallback(jobId), 3000);
  }

  private stopConnectFallbackPoll(): void {
    if (this.connectFallbackPoll === null) return;
    clearInterval(this.connectFallbackPoll);
    this.connectFallbackPoll = null;
  }

  /**
   * Consecutive fallback ticks that found the job no longer running and the
   * account still not connected. Not declared a failure on the first such
   * tick: `isJobRunning` and `githubStatus` are two separate IPC round
   * trips, so a tick landing in the brief window between the connect job
   * finishing and its keychain write becoming visible would otherwise read
   * as "the job ended without connecting" for a job that, a moment later,
   * plainly had.
   */
  private notConnectedAfterJobEndedStreak = 0;

  private async pollConnectFallback(jobId: string): Promise<void> {
    if (this.status() !== 'connecting') {
      this.stopConnectFallbackPoll();
      return;
    }
    let stillRunning: boolean;
    let result: GithubStatus;
    try {
      stillRunning = await this.tauri.isJobRunning(jobId);
      result = await this.tauri.githubStatus();
    } catch (error) {
      // A transient IPC/keychain error should not, by itself, declare the
      // connection failed — leave the streak alone and let the next tick
      // (or the push-based `notificationDone` event) resolve it instead.
      console.error('[github] fallback poll failed', error);
      return;
    }
    console.log('[github] fallback poll', { jobId, stillRunning, result });

    if (result.connected) {
      this.stopConnectFallbackPoll();
      void this.refreshStatus();
      return;
    }
    if (stillRunning) {
      this.notConnectedAfterJobEndedStreak = 0;
      return;
    }
    this.notConnectedAfterJobEndedStreak++;
    if (this.notConnectedAfterJobEndedStreak >= 2) {
      this.stopConnectFallbackPoll();
      this.error.set(this.blockedMessage || 'Could not connect to GitHub.');
      this.status.set('disconnected');
      this.deviceAuth.set(null);
    }
  }

  protected kindLabel(kind: PrEventKind): string {
    return KIND_LABELS[kind];
  }

  private async refreshStatus(): Promise<void> {
    // Loaded regardless of connection state: the client id has to be set
    // and saved *before* a first connection exists to configure it for.
    await this.loadSettings();

    const result = await this.tauri.githubStatus();
    if (result.connected) {
      this.username.set(result.username);
      this.status.set('connected');
    } else {
      this.status.set('disconnected');
    }
  }

  private async loadSettings(): Promise<void> {
    const settings = await this.tauri.githubSettings();
    this.clientId.set(settings.clientId ?? '');
    this.pollIntervalSecs.set(settings.pollIntervalSecs);
    this.notifications.set(toEditableNotifications(settings.notifications));
    this.muted.set([...settings.muted]);
  }

  private buildSettings(): GithubConnectorSettings {
    return {
      clientId: this.clientId().trim() || null,
      pollIntervalSecs: this.pollIntervalSecs(),
      notifications: fromEditableNotifications(this.notifications()),
      muted: this.muted(),
    };
  }

  protected save(): void {
    void this.tauri.setGithubSettings(this.buildSettings());
  }

  protected async connect(): Promise<void> {
    this.error.set('');
    this.blockedMessage = '';
    this.busy.set(true);
    try {
      const auth = await this.tauri.githubConnectStart();
      if (!auth) {
        this.error.set('Could not start GitHub sign-in.');
        return;
      }
      this.deviceAuth.set(auth);
      this.status.set('connecting');
      this.startConnectFallbackPoll(auth.jobId);
    } catch (error) {
      this.error.set(connectorErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected openDeveloperSettings(): void {
    void this.tauri.openUrl('https://github.com/settings/developers');
  }

  protected openVerification(auth: DeviceAuthorization): void {
    void this.tauri.openUrl(auth.verificationUri);
  }

  protected copyCode(auth: DeviceAuthorization): void {
    void navigator.clipboard.writeText(auth.userCode);
    if (this.copyCodeTimeout) clearTimeout(this.copyCodeTimeout);
    this.codeCopied.set(true);
    this.copyCodeTimeout = setTimeout(() => this.codeCopied.set(false), 2000);
  }

  protected async cancelConnect(auth: DeviceAuthorization): Promise<void> {
    this.stopConnectFallbackPoll();
    await this.tauri.cancelJob(auth.jobId);
    this.deviceAuth.set(null);
    this.status.set('disconnected');
  }

  protected async disconnect(): Promise<void> {
    await this.tauri.githubDisconnect();
    this.username.set(null);
    this.status.set('disconnected');
  }

  protected toggleKind(kind: PrEventKind): void {
    this.notifications.update((notifications) => ({
      ...notifications,
      [kind]: { ...notifications[kind], enabled: !notifications[kind].enabled },
    }));
    this.save();
  }

  protected addMute(): void {
    const key = this.newMuteKey().trim();
    if (!key) return;
    this.muted.update((muted) => (muted.includes(key) ? muted : [...muted, key]));
    this.newMuteKey.set('');
    this.save();
  }

  protected removeMute(key: string): void {
    this.muted.update((muted) => muted.filter((existing) => existing !== key));
    this.save();
  }
}
