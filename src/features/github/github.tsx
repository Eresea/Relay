import { Fragment } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Icon } from '@/shared/icon';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { when } from '@/lib/jsx';
import { useController, useSignals } from '@/lib/signals';
import { DestroyRef } from '@/lib/signals';
import { inject } from '@/lib/inject';
import { signal, untracked } from '@/lib/signals';

import { NexusAccount } from '@/core/nexus-account';
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
} from '@/core/tauri';

const GRANT_POLL_INTERVAL_MS = 3000;
/** Nexus grant requests expire after ten minutes. */
const GRANT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

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

import './github.css';

export class GithubState {
  private readonly tauri = inject(TauriBridge);
  readonly destroyRef = new DestroyRef();

  readonly kinds = PR_EVENT_KINDS;

  readonly status = signal<'loading' | 'disconnected' | 'connecting' | 'connected'>('loading');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly username = signal<string | null>(null);
  readonly githubConnection = signal<GithubStatus | null>(null);
  readonly webhookRepositories = signal<readonly GithubRepositorySummary[]>([]);
  readonly registeredWebhookRepos = signal<readonly string[]>([]);
  readonly selectedWebhookRepos = signal<string[]>([]);
  readonly webhookBusy = signal(false);
  readonly webhookError = signal('');
  readonly webhookSuccess = signal('');
  readonly nexusAuth = inject(NexusAccount).status;
  readonly deviceAuth = signal<DeviceAuthorization | null>(null);
  /** The consent page for an existing Nexus GitHub connection is open. */
  readonly grantPending = signal(false);
  private grantPoll: ReturnType<typeof setInterval> | null = null;
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

  readonly clientId = signal('');
  readonly notifications = signal<EditableNotifications>(
    toEditableNotifications(DEFAULT_GITHUB_SETTINGS.notifications),
  );
  readonly muted = signal<string[]>([]);
  readonly newMuteKey = signal('');

  readonly codeCopied = signal(false);
  private copyCodeTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Re-read on sign-in/out too: signing in loads the account's GitHub connection.
    this.destroyRef.effect(() => {
      void this.nexusAuth().connected;
      untracked(() => void this.refreshStatus());
    });

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
      this.stopGrantPoll();
      this.stopConnectFallbackPoll();
      if (this.copyCodeTimeout) clearTimeout(this.copyCodeTimeout);
    });
  }

  /**
   * Asks Nexus for access to a GitHub connection another app created and opens the consent page.
   * The grant arrives out of band, so poll Nexus until Relay can read the connection (or the
   * request expires).
   */
  async useNexusConnection(credentialId: string): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.tauri.githubUseNexusConnection(credentialId);
    } catch (error) {
      this.error.set(connectorErrorMessage(error));
      return;
    } finally {
      this.busy.set(false);
    }
    this.grantPending.set(true);
    this.stopGrantPoll();
    const expiresAt = Date.now() + GRANT_POLL_TIMEOUT_MS;
    this.grantPoll = setInterval(() => void this.pollGrant(expiresAt), GRANT_POLL_INTERVAL_MS);
  }

  private async pollGrant(expiresAt: number): Promise<void> {
    try {
      if ((await this.tauri.githubAdoptConnection())?.connected) {
        this.stopGrantPoll();
        await this.refreshStatus();
        return;
      }
    } catch {
      // Transient (offline, signed out): keep waiting until the request expires.
    }
    if (Date.now() >= expiresAt) this.stopGrantPoll();
  }

  private stopGrantPoll(): void {
    if (this.grantPoll !== null) clearInterval(this.grantPoll);
    this.grantPoll = null;
    this.grantPending.set(false);
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

  kindLabel(kind: PrEventKind): string {
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

  save(): void {
    void this.tauri.setGithubSettings(this.buildSettings());
  }

  toggleWebhookRepo(repository: string): void {
    this.selectedWebhookRepos.update((selected) =>
      selected.includes(repository)
        ? selected.filter((value) => value !== repository)
        : [...selected, repository],
    );
  }

  async registerWebhooks(): Promise<void> {
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

  async unregisterWebhook(repository: string): Promise<void> {
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

  async connect(): Promise<void> {
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

  openDeveloperSettings(): void {
    void this.tauri.openUrl('https://github.com/settings/developers');
  }

  openVerification(auth: DeviceAuthorization): void {
    void this.tauri.openUrl(auth.verificationUri);
  }

  async copyCode(auth: DeviceAuthorization): Promise<void> {
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

  async cancelConnect(auth: DeviceAuthorization): Promise<void> {
    this.stopConnectFallbackPoll();
    this.codeCopied.set(false);
    await this.tauri.cancelJob(auth.jobId);
    this.deviceAuth.set(null);
    this.status.set('disconnected');
  }

  async disconnect(): Promise<void> {
    await this.tauri.githubDisconnect();
    this.username.set(null);
    this.status.set('disconnected');
  }

  toggleKind(kind: PrEventKind): void {
    this.notifications.update((notifications) => ({
      ...notifications,
      [kind]: { ...notifications[kind], enabled: !notifications[kind].enabled },
    }));
    this.save();
  }

  addMute(): void {
    const key = this.newMuteKey().trim();
    if (!key) return;
    this.muted.update((muted) => (muted.includes(key) ? muted : [...muted, key]));
    this.newMuteKey.set('');
    this.save();
  }

  removeMute(key: string): void {
    this.muted.update((muted) => muted.filter((existing) => existing !== key));
    this.save();
  }
}

export function Github() {
  useSignals();
  const s = useController(() => new GithubState());
  return (
    <div className="github">
      <section className="wrap">
        {s.status() === 'disconnected' ? (
          <>
            <div className="connect">
              <Icon name="inbox" size={20} />
              <p className="u-title">Connect GitHub</p>
              <p className="hint">
                Relay receives pull request and CI events for repositories with webhooks enabled,
                then applies the notification rules below.
              </p>

              {when(s.githubConnection()?.available, (available) => (
                <>
                  <div className="client-id-setup">
                    <p className="hint">
                      Your Nexus account already has a GitHub connection ({available.label}) from
                      {available.app}.
                    </p>
                    {s.grantPending() ? (
                      <>
                        <p className="hint">
                          Approve access in your browser; Relay picks it up automatically.
                        </p>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="default"
                          disabled={s.busy()}
                          onClick={() => {
                            void s.useNexusConnection(available.id);
                          }}
                        >
                          Use GitHub connection from {available.app}
                        </Button>
                      </>
                    )}
                  </div>
                </>
              ))}

              <div className="client-id-setup">
                <p className="hint">
                  Needs a GitHub OAuth App with Device Flow enabled. Create one, then paste its
                  client id below.
                </p>
                <Button
                  size="sm"
                  variant="link"
                  onClick={() => {
                    void s.openDeveloperSettings();
                  }}
                >
                  Open GitHub Developer Settings
                </Button>
                <Input
                  placeholder="OAuth App client id"
                  value={s.clientId()}
                  onValueChange={($event) => {
                    void s.clientId.set($event);
                  }}
                  onBlur={() => {
                    void s.save();
                  }}
                />
              </div>

              <Button
                variant="default"
                disabled={s.busy() || !s.clientId().trim()}
                onClick={() => {
                  void s.connect();
                }}
              >
                Connect
              </Button>
              {s.error() ? (
                <>
                  <p className="error">{s.error()}</p>
                </>
              ) : null}
            </div>
          </>
        ) : s.status() === 'connecting' ? (
          <>
            {when(s.deviceAuth(), (auth) => (
              <>
                <div className="connect">
                  <Icon name="inbox" size={20} />
                  <p className="u-title">Enter this code on GitHub</p>
                  <code className="user-code">{auth.userCode}</code>
                  <p className="hint">{auth.verificationUri}</p>
                  <div className="connect-actions">
                    <Button
                      onClick={() => {
                        void s.openVerification(auth);
                      }}
                    >
                      {' '}
                      Open on GitHub{' '}
                    </Button>
                    <Button
                      size="sm"
                      variant="link"
                      onClick={() => {
                        void s.copyCode(auth);
                      }}
                    >
                      {s.codeCopied() ? 'Copied' : 'Copy code'}
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    variant="link"
                    onClick={() => {
                      void s.cancelConnect(auth);
                    }}
                  >
                    Cancel
                  </Button>
                  {s.error() ? (
                    <>
                      <p className="error">{s.error()}</p>
                    </>
                  ) : null}
                </div>
              </>
            ))}
          </>
        ) : s.status() === 'connected' ? (
          <>
            <section className="group">
              <div className="row-header">
                <h2 className="u-caption">Account</h2>
                <Button
                  size="sm"
                  variant="link"
                  onClick={() => {
                    void s.disconnect();
                  }}
                >
                  Disconnect
                </Button>
              </div>
              <div className="row">
                <div className="account-status">
                  <span className="status-dot" />
                  <p className="label">
                    Connected as <strong>{s.username()}</strong>
                  </p>
                </div>
              </div>
              {s.nexusAuth().connected ? (
                <>
                  <p className="hint">Your GitHub connection is saved in your Nexus account.</p>
                </>
              ) : null}
            </section>

            <section className="group">
              <h2 className="u-caption">Nexus webhooks</h2>
              <p className="hint">
                Select repositories where you can manage hooks. Nexus stores pull request deliveries
                while Relay is offline; Relay applies your notification rules when it reconnects.
                Your GitHub account must have admin access to each repository. The existing repo
                scope can manage hooks and also grants broad repository access.
              </p>
              {!s.nexusAuth().connected ? (
                <>
                  <p className="hint">
                    Sign in with Nexus from the account button below Settings to enable webhook
                    delivery.
                  </p>
                </>
              ) : s.webhookRepositories().length === 0 ? (
                <>
                  <p className="hint">No repositories are available from GitHub.</p>
                </>
              ) : (
                <>
                  <div className="webhook-repositories">
                    {s.webhookRepositories().map((repo) => {
                      return (
                        <Fragment key={repo.fullName}>
                          <div className="webhook-repository">
                            <Checkbox
                              label={repo.fullName}
                              checked={s.selectedWebhookRepos().includes(repo.fullName)}
                              onCheckedChange={() => {
                                void s.toggleWebhookRepo(repo.fullName);
                              }}
                            />
                          </div>
                        </Fragment>
                      );
                    })}
                  </div>
                  <Button
                    disabled={s.webhookBusy() || s.selectedWebhookRepos().length === 0}
                    onClick={() => {
                      void s.registerWebhooks();
                    }}
                  >
                    {s.webhookBusy() ? 'Registering…' : 'Enable webhooks for selected repos'}
                  </Button>
                </>
              )}
              {s.registeredWebhookRepos().map((repository) => {
                return (
                  <Fragment key={repository}>
                    <div className="entry">
                      <code>{repository}</code>
                      <Button
                        size="sm"
                        variant="link"
                        disabled={s.webhookBusy()}
                        onClick={() => {
                          void s.unregisterWebhook(repository);
                        }}
                      >
                        Remove webhook
                      </Button>
                    </div>
                  </Fragment>
                );
              })}
              {s.webhookError() ? (
                <>
                  <p className="error">{s.webhookError()}</p>
                </>
              ) : null}
              {s.webhookSuccess() ? (
                <>
                  <p className="hint">{s.webhookSuccess()}</p>
                </>
              ) : null}
            </section>

            <section className="group">
              <h2 className="u-caption">Notifications</h2>
              <p className="hint notifications-hint">
                One switch per kind of activity. Scope any of them to specific repos or branches —
                empty branch fields mean every branch.
              </p>

              {s.kinds.map((kind) => {
                return (
                  <Fragment key={kind}>
                    {((rule) => (
                      <>
                        <div className={cn('rule', !rule.enabled && 'rule-disabled')}>
                          <div className="rule-header">
                            <Switch
                              checked={rule.enabled}
                              aria-label={s.kindLabel(kind)}
                              onCheckedChange={() => {
                                void s.toggleKind(kind);
                              }}
                            />
                            <p className="label kind-label">{s.kindLabel(kind)}</p>
                          </div>

                          <div className="rule-fields">
                            <Input
                              placeholder="Repo pattern, e.g. my-org/*"
                              value={rule.repoPattern}
                              onValueChange={($event) => (rule.repoPattern = $event)}
                              onBlur={() => {
                                void s.save();
                              }}
                            />
                            <Input
                              placeholder="Branches to include (comma-separated globs, empty = all)"
                              value={rule.branchInclude}
                              onValueChange={($event) => (rule.branchInclude = $event)}
                              onBlur={() => {
                                void s.save();
                              }}
                            />
                            <Input
                              placeholder="Branches to exclude"
                              value={rule.branchExclude}
                              onValueChange={($event) => (rule.branchExclude = $event)}
                              onBlur={() => {
                                void s.save();
                              }}
                            />
                          </div>
                        </div>
                      </>
                    ))(s.notifications()[kind])}
                  </Fragment>
                );
              })}
            </section>

            <section className="group">
              <h2 className="u-caption">Muted</h2>
              <p className="hint">
                Exact exceptions: a repo (<code>owner/repo</code>), a branch (
                <code>owner/repo&#64;branch</code>), or one pull request (
                <code>owner/repo#123</code>).
              </p>

              {s.muted().length === 0 ? (
                <>
                  <p className="hint">Nothing muted.</p>
                </>
              ) : (
                <>
                  {s.muted().map((key) => {
                    return (
                      <Fragment key={key}>
                        <div className="entry">
                          <code className="mute-key">{key}</code>
                          <Button
                            size="icon"
                            variant="destructive"
                            aria-label="Remove mute"
                            onClick={() => {
                              void s.removeMute(key);
                            }}
                          >
                            <Icon name="trash-2" size={16} />
                          </Button>
                        </div>
                      </Fragment>
                    );
                  })}
                </>
              )}

              <form
                className="mute-form"
                onSubmit={($event) => {
                  $event.preventDefault();
                  void s.addMute();
                }}
              >
                <Input
                  placeholder="owner/repo"
                  value={s.newMuteKey()}
                  onValueChange={($event) => {
                    void s.newMuteKey.set($event);
                  }}
                />
                <Button type="submit" size="sm" variant="link" disabled={!s.newMuteKey().trim()}>
                  Mute
                </Button>
              </form>
            </section>
          </>
        ) : (
          <>
            <p className="hint loading">Loading…</p>
          </>
        )}
      </section>
    </div>
  );
}
