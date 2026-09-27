import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { NexusAccount } from '@core/nexus-account';
import {
  DEFAULT_GITHUB_SETTINGS,
  PR_EVENT_KINDS,
  TauriBridge,
  ruleFor,
  type DeviceAuthorization,
  type GithubConnectorSettings,
  type GithubStatus,
  type GithubRepositorySummary,
  type NotificationSettings,
  type NotificationTypeRule,
  type PrEventKind,
} from '@core/tauri';
import { Icon } from '@shared/icon';
import { UmbraButtonComponent } from '@umbra/components/umbra-button/umbra-button.component';
import { UmbraInputComponent } from '@umbra/components/umbra-input/umbra-input.component';
import { UmbraCheckboxComponent } from '@umbra/components/umbra-checkbox/umbra-checkbox.component';
import { UmbraSwitchComponent } from '@umbra/components/umbra-switch/umbra-switch.component';

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
 * of event. GitHub events arrive through Nexus webhooks; this component only ever shows connection
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
  imports: [
    FormsModule,
    Icon,
    UmbraButtonComponent,
    UmbraCheckboxComponent,
    UmbraInputComponent,
    UmbraSwitchComponent,
  ],
  template: `
    <section class="wrap">
      @switch (status()) {
        @case ('disconnected') {
          <div class="connect">
            <rl-icon name="inbox" [size]="20" />
            <p class="u-title">Connect GitHub</p>
            <p class="hint">
              Relay receives pull request and CI events for repositories with webhooks enabled, then
              applies the notification rules below.
            </p>

            <div class="client-id-setup">
              <p class="hint">
                Needs a GitHub OAuth App with Device Flow enabled. Create one, then paste its client
                id below.
              </p>
              <umbra-button size="sm" variant="link" (click)="openDeveloperSettings()">
                Open GitHub Developer Settings
              </umbra-button>
              <umbra-input
                placeholder="OAuth App client id"
                [value]="clientId()"
                (valueChange)="clientId.set($event)"
                (touch)="save()"
              />
            </div>

            <umbra-button
              variant="default"
              [disabled]="busy() || !clientId().trim()"
              (click)="connect()"
            >
              Connect
            </umbra-button>
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
                <umbra-button (click)="openVerification(auth)"> Open on GitHub </umbra-button>
                <umbra-button size="sm" variant="link" (click)="copyCode(auth)">
                  {{ codeCopied() ? 'Copied' : 'Copy code' }}
                </umbra-button>
              </div>
              <umbra-button size="sm" variant="link" (click)="cancelConnect(auth)"
                >Cancel</umbra-button
              >
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
              <umbra-button size="sm" variant="link" (click)="disconnect()"
                >Disconnect</umbra-button
              >
            </div>
            <div class="row">
              <div class="account-status">
                <span class="status-dot"></span>
                <p class="label">
                  Connected as <strong>{{ username() }}</strong>
                </p>
              </div>
            </div>
            @if (githubConnection()?.nexusCredentialReady) {
              <p class="hint">GitHub credentials are stored in Nexus.</p>
            } @else if (githubConnection()?.nexusCredentialPending) {
              <p class="hint">
                Grant Relay read and replace access to this GitHub credential in Nexus. Relay keeps
                the local copy until it can read the saved credential back.
              </p>
            }
          </section>

          <section class="group">
            <h2 class="u-caption">Nexus webhooks</h2>
            <p class="hint">
              Select repositories where you can manage hooks. Nexus stores pull request deliveries
              while Relay is offline; Relay applies your notification rules when it reconnects. Your
              GitHub account must have admin access to each repository. The existing repo scope can
              manage hooks and also grants broad repository access.
            </p>
            @if (!nexusAuth().connected) {
              <p class="hint">
                Connect through the account button below Settings to enable webhook delivery.
              </p>
            } @else if (webhookRepositories().length === 0) {
              <p class="hint">No repositories are available from GitHub.</p>
            } @else {
              <div class="webhook-repositories">
                @for (repo of webhookRepositories(); track repo.fullName) {
                  <div class="webhook-repository">
                    <umbra-checkbox
                      [label]="repo.fullName"
                      [value]="selectedWebhookRepos().includes(repo.fullName)"
                      (valueChange)="toggleWebhookRepo(repo.fullName)"
                    />
                  </div>
                }
              </div>
              <umbra-button
                [disabled]="webhookBusy() || selectedWebhookRepos().length === 0"
                (click)="registerWebhooks()"
              >
                {{ webhookBusy() ? 'Registering…' : 'Enable webhooks for selected repos' }}
              </umbra-button>
            }
            @for (repository of registeredWebhookRepos(); track repository) {
              <div class="entry">
                <code>{{ repository }}</code>
                <umbra-button
                  size="sm"
                  variant="link"
                  [disabled]="webhookBusy()"
                  (click)="unregisterWebhook(repository)"
                >
                  Remove webhook
                </umbra-button>
              </div>
            }
            @if (webhookError()) {
              <p class="error">{{ webhookError() }}</p>
            }
            @if (webhookSuccess()) {
              <p class="hint">{{ webhookSuccess() }}</p>
            }
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
                  <umbra-switch
                    [value]="rule.enabled"
                    [ariaLabel]="kindLabel(kind)"
                    (valueChange)="toggleKind(kind)"
                  />
                  <p class="label kind-label">{{ kindLabel(kind) }}</p>
                </div>

                <div class="rule-fields">
                  <umbra-input
                    placeholder="Repo pattern, e.g. my-org/*"
                    [value]="rule.repoPattern"
                    (valueChange)="rule.repoPattern = $event"
                    (touch)="save()"
                  />
                  <umbra-input
                    placeholder="Branches to include (comma-separated globs, empty = all)"
                    [value]="rule.branchInclude"
                    (valueChange)="rule.branchInclude = $event"
                    (touch)="save()"
                  />
                  <umbra-input
                    placeholder="Branches to exclude"
                    [value]="rule.branchExclude"
                    (valueChange)="rule.branchExclude = $event"
                    (touch)="save()"
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
                  <umbra-button
                    size="icon"
                    variant="destructive"
                    ariaLabel="Remove mute"
                    (click)="removeMute(key)"
                  >
                    <rl-icon umbraButtonIcon name="trash-2" [size]="16" />
                  </umbra-button>
                </div>
              }
            }

            <form class="mute-form" (ngSubmit)="addMute()">
              <umbra-input
                placeholder="owner/repo"
                [value]="newMuteKey()"
                (valueChange)="newMuteKey.set($event)"
              />
              <umbra-button
                type="submit"
                size="sm"
                variant="link"
                [disabled]="!newMuteKey().trim()"
              >
                Mute
              </umbra-button>
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

    .webhook-repositories {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: var(--space-2);
      margin-block: var(--space-4);
    }

    .webhook-repository {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-block-size: 40px;
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

    :host ::ng-deep .client-id-setup umbra-input {
      inline-size: 100%;
    }

    :host ::ng-deep .option umbra-input {
      inline-size: 5.5em;
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

    .rule-fields umbra-input {
      flex: 1;
      min-inline-size: 0;
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

    .mute-form umbra-input {
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
  protected readonly githubConnection = signal<GithubStatus | null>(null);
  protected readonly webhookRepositories = signal<readonly GithubRepositorySummary[]>([]);
  protected readonly registeredWebhookRepos = signal<readonly string[]>([]);
  protected readonly selectedWebhookRepos = signal<string[]>([]);
  protected readonly webhookBusy = signal(false);
  protected readonly webhookError = signal('');
  protected readonly webhookSuccess = signal('');
  protected readonly nexusAuth = inject(NexusAccount).status;
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
    this.githubConnection.set(result);
    if (result.connected) {
      this.username.set(result.username);
      this.status.set('connected');
      try {
        this.webhookRepositories.set(await this.tauri.githubRepositories());
      } catch {
        this.webhookRepositories.set([]);
      }
    } else {
      this.webhookRepositories.set([]);
      this.status.set('disconnected');
    }
  }

  private async loadSettings(): Promise<void> {
    const settings = await this.tauri.githubSettings();
    this.clientId.set(settings.clientId ?? '');
    this.notifications.set(toEditableNotifications(settings.notifications));
    this.muted.set([...settings.muted]);
    try {
      this.registeredWebhookRepos.set(await this.tauri.githubWebhookRepositories());
    } catch {
      this.registeredWebhookRepos.set([]);
    }
  }

  private buildSettings(): GithubConnectorSettings {
    return {
      clientId: this.clientId().trim() || null,
      notifications: fromEditableNotifications(this.notifications()),
      muted: this.muted(),
    };
  }

  protected save(): void {
    void this.tauri.setGithubSettings(this.buildSettings());
  }

  protected toggleWebhookRepo(repository: string): void {
    this.selectedWebhookRepos.update((selected) =>
      selected.includes(repository)
        ? selected.filter((value) => value !== repository)
        : [...selected, repository],
    );
  }

  protected async registerWebhooks(): Promise<void> {
    this.webhookBusy.set(true);
    this.webhookError.set('');
    this.webhookSuccess.set('');
    try {
      const registered = await this.tauri.githubRegisterWebhooks(this.selectedWebhookRepos());
      this.registeredWebhookRepos.set(await this.tauri.githubWebhookRepositories());
      this.webhookSuccess.set(
        registered.length
          ? `Enabled: ${registered.join(', ')}`
          : 'Selected repositories already have webhooks enabled.',
      );
      this.selectedWebhookRepos.set([]);
    } catch (error) {
      this.webhookError.set(connectorErrorMessage(error));
    } finally {
      this.webhookBusy.set(false);
    }
  }

  protected async unregisterWebhook(repository: string): Promise<void> {
    this.webhookBusy.set(true);
    this.webhookError.set('');
    this.webhookSuccess.set('');
    try {
      await this.tauri.githubUnregisterWebhook(repository);
      this.registeredWebhookRepos.update((repos) => repos.filter((repo) => repo !== repository));
      this.webhookSuccess.set(`Removed webhook for ${repository}.`);
    } catch (error) {
      this.webhookError.set(connectorErrorMessage(error));
    } finally {
      this.webhookBusy.set(false);
    }
  }

  protected async connect(): Promise<void> {
    this.error.set('');
    this.blockedMessage = '';
    this.codeCopied.set(false);
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

  protected async copyCode(auth: DeviceAuthorization): Promise<void> {
    if (this.copyCodeTimeout) clearTimeout(this.copyCodeTimeout);
    this.copyCodeTimeout = null;
    this.codeCopied.set(false);
    try {
      await navigator.clipboard.writeText(auth.userCode);
    } catch {
      return;
    }
    this.codeCopied.set(true);
    this.copyCodeTimeout = setTimeout(() => {
      this.codeCopied.set(false);
      this.copyCodeTimeout = null;
    }, 2000);
  }

  protected async cancelConnect(auth: DeviceAuthorization): Promise<void> {
    this.stopConnectFallbackPoll();
    this.codeCopied.set(false);
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
