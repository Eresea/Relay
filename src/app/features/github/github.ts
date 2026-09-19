import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  DEFAULT_GITHUB_SETTINGS,
  TauriBridge,
  type DeviceAuthorization,
  type GithubConnectorSettings,
  type NotificationRule,
  type PrEventKind,
} from '@core/tauri';
import { Icon } from '@shared/icon';

const STATUS_LABELS: readonly (readonly [PrEventKind, string])[] = [
  ['opened', 'Opened'],
  ['merged', 'Merged'],
  ['closed', 'Closed'],
  ['review_requested', 'Review requested'],
  ['ci_failed', 'CI failed'],
  ['ci_passed', 'CI passed'],
];

let nextRuleId = 0;

/** A `NotificationRule` with its glob lists as comma-separated text, for binding to a single field. */
interface EditableRule {
  id: string;
  enabled: boolean;
  repoPattern: string;
  branchInclude: string;
  branchExclude: string;
  statuses: Set<PrEventKind>;
}

function toEditable(rule: NotificationRule): EditableRule {
  return {
    id: rule.id,
    enabled: rule.enabled,
    repoPattern: rule.repoPattern,
    branchInclude: rule.branchInclude.join(', '),
    branchExclude: rule.branchExclude.join(', '),
    statuses: new Set(rule.statuses),
  };
}

function fromEditable(rule: EditableRule): NotificationRule {
  return {
    id: rule.id,
    enabled: rule.enabled,
    repoPattern: rule.repoPattern.trim() || '*',
    branchInclude: splitList(rule.branchInclude),
    branchExclude: splitList(rule.branchExclude),
    statuses: [...rule.statuses],
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
 * which pull request activity is worth a notification. The poll job itself
 * lives entirely core-side (`src-tauri/src/github`); this component only
 * ever shows connection status and edits `settings.json` — it never talks to
 * GitHub directly.
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
              your rules ask for — new PRs, reviews requested, and CI results.
            </p>
            <button type="button" class="primary" [disabled]="busy()" (click)="connect()">
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
                <button type="button" class="link" (click)="copyCode(auth)">Copy code</button>
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
              <p class="label">Connected as {{ username() }}</p>
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
            <div class="row-header">
              <h2 class="u-caption">Rules</h2>
              <button type="button" class="link" (click)="addRule()">Add rule</button>
            </div>

            @if (rules().length === 0) {
              <p class="hint">No rules — nothing will notify you yet.</p>
            }

            @for (rule of rules(); track rule.id) {
              <div class="rule">
                <div class="rule-header">
                  <button
                    type="button"
                    role="switch"
                    class="switch"
                    [attr.aria-checked]="rule.enabled"
                    (click)="toggleEnabled(rule)"
                  >
                    <span class="switch-thumb"></span>
                  </button>
                  <input
                    class="field repo-field"
                    placeholder="Repo pattern, e.g. my-org/*"
                    [(ngModel)]="rule.repoPattern"
                    (change)="save()"
                  />
                  <button
                    type="button"
                    class="icon-btn danger"
                    (click)="removeRule(rule.id)"
                    aria-label="Delete rule"
                  >
                    <rl-icon name="trash-2" [size]="16" />
                  </button>
                </div>

                <div class="rule-branches">
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

                <div class="statuses">
                  @for (status of statusLabels; track status[0]) {
                    <label class="check">
                      <input
                        type="checkbox"
                        [checked]="rule.statuses.has(status[0])"
                        (change)="toggleStatus(rule, status[0])"
                      />
                      <span>{{ status[1] }}</span>
                    </label>
                  }
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
      padding: var(--space-8);
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

    .repo-field {
      flex: 1;
    }

    .rule-branches {
      display: flex;
      gap: var(--space-3);
      margin-block-end: var(--space-3);
    }

    .rule-branches .field {
      flex: 1;
    }

    .statuses {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-4);
      font-size: var(--text-13);
      color: var(--text-muted);
    }

    .check {
      display: flex;
      align-items: center;
      gap: var(--space-1);
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

  protected readonly statusLabels = STATUS_LABELS;

  protected readonly status = signal<'loading' | 'disconnected' | 'connecting' | 'connected'>(
    'loading',
  );
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly username = signal<string | null>(null);
  protected readonly deviceAuth = signal<DeviceAuthorization | null>(null);

  protected readonly pollIntervalSecs = signal(DEFAULT_GITHUB_SETTINGS.pollIntervalSecs);
  protected readonly rules = signal<EditableRule[]>([]);
  protected readonly muted = signal<string[]>([]);
  protected readonly newMuteKey = signal('');

  constructor() {
    void this.refreshStatus();

    void this.tauri
      .onEvent((event) => {
        if (event.type === 'openGithubRequested') void this.refreshStatus();
        if (
          event.type === 'notificationDone' &&
          event.jobId === this.deviceAuth()?.jobId &&
          this.status() === 'connecting'
        ) {
          if (event.ok) {
            void this.refreshStatus();
          } else {
            this.error.set(
              'Could not connect to GitHub. The code may have expired or been declined.',
            );
            this.status.set('disconnected');
            this.deviceAuth.set(null);
          }
        }
      })
      .then((unlisten) => this.destroyRef.onDestroy(unlisten));
  }

  private async refreshStatus(): Promise<void> {
    const result = await this.tauri.githubStatus();
    if (result.connected) {
      this.username.set(result.username);
      this.status.set('connected');
      await this.loadSettings();
    } else {
      this.status.set('disconnected');
    }
  }

  private async loadSettings(): Promise<void> {
    const settings = await this.tauri.githubSettings();
    this.pollIntervalSecs.set(settings.pollIntervalSecs);
    this.rules.set(settings.rules.map(toEditable));
    this.muted.set([...settings.muted]);
  }

  private buildSettings(): GithubConnectorSettings {
    return {
      pollIntervalSecs: this.pollIntervalSecs(),
      rules: this.rules().map(fromEditable),
      muted: this.muted(),
    };
  }

  protected save(): void {
    void this.tauri.setGithubSettings(this.buildSettings());
  }

  protected async connect(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      const auth = await this.tauri.githubConnectStart();
      if (!auth) {
        this.error.set('Could not start GitHub sign-in.');
        return;
      }
      this.deviceAuth.set(auth);
      this.status.set('connecting');
    } catch (error) {
      this.error.set(connectorErrorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected openVerification(auth: DeviceAuthorization): void {
    void this.tauri.openUrl(auth.verificationUri);
  }

  protected copyCode(auth: DeviceAuthorization): void {
    void navigator.clipboard.writeText(auth.userCode);
  }

  protected async cancelConnect(auth: DeviceAuthorization): Promise<void> {
    await this.tauri.cancelJob(auth.jobId);
    this.deviceAuth.set(null);
    this.status.set('disconnected');
  }

  protected async disconnect(): Promise<void> {
    await this.tauri.githubDisconnect();
    this.username.set(null);
    this.status.set('disconnected');
  }

  protected addRule(): void {
    this.rules.update((rules) => [
      ...rules,
      {
        id: `rule-${Date.now()}-${nextRuleId++}`,
        enabled: true,
        repoPattern: '*',
        branchInclude: '',
        branchExclude: '',
        statuses: new Set<PrEventKind>(['opened']),
      },
    ]);
    this.save();
  }

  protected removeRule(id: string): void {
    this.rules.update((rules) => rules.filter((rule) => rule.id !== id));
    this.save();
  }

  protected toggleEnabled(rule: EditableRule): void {
    rule.enabled = !rule.enabled;
    this.rules.update((rules) => [...rules]);
    this.save();
  }

  protected toggleStatus(rule: EditableRule, kind: PrEventKind): void {
    if (rule.statuses.has(kind)) {
      rule.statuses.delete(kind);
    } else {
      rule.statuses.add(kind);
    }
    this.rules.update((rules) => [...rules]);
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
