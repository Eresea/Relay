import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TauriBridge, type GmailStatus, type Rule, type RuleKind } from '@core/tauri';
import { Icon } from '@shared/icon';

let nextRuleId = 0;

/**
 * The Gmail connector's settings surface, embedded as a group inside
 * `Settings` (`src/app/features/settings/settings.ts`) the same way
 * Appearance and Startup are — there is no separate top-level view or
 * palette command the way the vault gets one, since this is one panel of
 * settings rather than a whole workspace.
 *
 * All of the connector's state (OAuth tokens, poll checkpoint, rules) lives
 * core-side in `src-tauri/src/gmail/mod.rs` so it keeps polling with no
 * window open; this component only ever reflects and edits it through
 * `TauriBridge`, never holds it as the source of truth.
 */
@Component({
  selector: 'rl-gmail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Icon],
  template: `
    <section class="group">
      <h2 class="u-caption">Gmail</h2>

      @if (status().connected) {
        <div class="row">
          <div>
            <p class="label">{{ status().accountEmail }}</p>
            <p class="hint">Polling every {{ pollIntervalSecs() }}s for new inbox mail.</p>
          </div>
          <button type="button" class="link" [disabled]="busy()" (click)="disconnect()">
            Disconnect
          </button>
        </div>

        <div class="row">
          <div>
            <p class="label">Notify on every new message</p>
            <p class="hint">
              Off by default — only Gmail's Important label triggers a HUD notification.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            class="switch"
            [attr.aria-checked]="notifyAll()"
            (click)="toggleNotifyAll()"
          >
            <span class="switch-thumb"></span>
          </button>
        </div>

        <div class="row">
          <div>
            <p class="label">Notify on Gmail's Important label</p>
            <p class="hint">Gmail's own priority-inbox signal.</p>
          </div>
          <button
            type="button"
            role="switch"
            class="switch"
            [attr.aria-checked]="notifyImportant()"
            (click)="toggleNotifyImportant()"
          >
            <span class="switch-thumb"></span>
          </button>
        </div>

        <div class="row poll-row">
          <div>
            <p class="label">Poll interval</p>
            <p class="hint">How often to check for new mail, in seconds (minimum 30).</p>
          </div>
          <input
            class="field poll-field"
            type="number"
            min="30"
            [(ngModel)]="pollIntervalSecs"
            [ngModelOptions]="{ updateOn: 'blur' }"
            (ngModelChange)="saveSettings()"
          />
        </div>

        <div class="rules">
          <p class="label">Custom rules</p>
          @if (rules().length === 0) {
            <p class="hint">No custom rules yet.</p>
          } @else {
            @for (rule of rules(); track rule.id) {
              <div class="rule">
                <button
                  type="button"
                  role="switch"
                  class="switch switch-sm"
                  [attr.aria-checked]="rule.enabled"
                  (click)="toggleRule(rule.id)"
                >
                  <span class="switch-thumb"></span>
                </button>
                <span class="rule-text">{{ describeRule(rule) }}</span>
                <button
                  type="button"
                  class="icon-btn"
                  (click)="removeRule(rule.id)"
                  aria-label="Remove rule"
                >
                  <rl-icon name="trash-2" [size]="14" />
                </button>
              </div>
            }
          }

          <form class="rule-form" (ngSubmit)="addRule()">
            <select class="field" [(ngModel)]="newRuleKind" name="newRuleKind">
              <option value="fromContains">From contains</option>
              <option value="subjectContains">Subject contains</option>
              <option value="label">Has label</option>
            </select>
            <input
              class="field rule-input"
              [placeholder]="newRuleKind() === 'label' ? 'STARRED' : 'e.g. boss@work.com'"
              [(ngModel)]="newRuleText"
              name="newRuleText"
              required
            />
            <button type="submit" class="link" [disabled]="!newRuleText().trim()">Add</button>
          </form>
        </div>
      } @else if (status().connecting) {
        <div class="row">
          <div>
            <p class="label">Waiting for the browser</p>
            <p class="hint">Complete sign-in in the window Relay just opened.</p>
          </div>
          <button type="button" class="link" (click)="cancelConnect()">Cancel</button>
        </div>
      } @else {
        <div class="row">
          <div>
            <p class="label">Not connected</p>
            <p class="hint">Get a HUD notification for important new mail.</p>
          </div>
          <button type="button" class="link" [disabled]="busy()" (click)="connect()">
            Connect Gmail
          </button>
        </div>
      }

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }
    </section>
  `,
  styles: `
    .group {
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

    .link:disabled {
      opacity: 0.5;
    }

    .field {
      padding: var(--space-2) var(--space-3);
      font-size: var(--text-13);
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      color: var(--text-body);
    }

    .poll-field {
      inline-size: 5em;
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

    .switch-sm {
      inline-size: 28px;
      block-size: 16px;
    }

    .switch-sm .switch-thumb {
      inline-size: 12px;
      block-size: 12px;
    }

    .switch-sm[aria-checked='true'] .switch-thumb {
      transform: translateX(12px);
    }

    .rules {
      padding-block-start: var(--space-5);
    }

    .rule {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-2) 0;
    }

    .rule-text {
      flex: 1;
      font-size: var(--text-13);
      color: var(--text-body);
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
      color: var(--danger-ink);
      background: var(--danger);
    }

    .rule-form {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-block-start: var(--space-3);
    }

    .rule-input {
      flex: 1;
    }

    .error {
      margin: var(--space-3) 0 0;
      font-size: var(--text-12);
      color: var(--danger-ink);
    }
  `,
})
export class Gmail {
  private readonly tauri = inject(TauriBridge);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly status = signal<GmailStatus>({
    connected: false,
    connecting: false,
    accountEmail: null,
  });
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected readonly notifyAll = signal(false);
  protected readonly notifyImportant = signal(true);
  protected readonly pollIntervalSecs = signal(60);
  protected readonly rules = signal<readonly Rule[]>([]);

  protected readonly newRuleKind = signal<RuleKind['kind']>('fromContains');
  protected readonly newRuleText = signal('');

  constructor() {
    void this.refresh();

    void this.tauri
      .onEvent(() => void this.refresh())
      .then((unlisten) => this.destroyRef.onDestroy(unlisten));
  }

  private async refresh(): Promise<void> {
    this.status.set(await this.tauri.gmailStatus());
    if (this.status().connected) {
      const settings = await this.tauri.gmailGetSettings();
      this.notifyAll.set(settings.rules.notifyAll);
      this.notifyImportant.set(settings.rules.notifyImportant);
      this.pollIntervalSecs.set(settings.pollIntervalSecs);
      this.rules.set(settings.rules.custom);
    }
  }

  protected async connect(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    this.status.update((s) => ({ ...s, connecting: true }));
    try {
      await this.tauri.gmailConnect();
      await this.refresh();
    } catch (error) {
      // The core's `Error` enum serializes to a plain string (see
      // src-tauri/src/error.rs), so `error` here is already a message worth
      // showing directly — e.g. "the Gmail connector needs
      // RELAY_GMAIL_CLIENT_ID set before it can connect" — rather than a
      // generic one that hides why a fast-failing case (no client id
      // configured) looks identical to a real connection failure.
      this.error.set(typeof error === 'string' ? error : 'Could not connect to Gmail.');
      await this.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  protected async cancelConnect(): Promise<void> {
    await this.tauri.gmailCancelConnect();
  }

  protected async disconnect(): Promise<void> {
    this.busy.set(true);
    try {
      await this.tauri.gmailDisconnect();
      await this.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  protected toggleNotifyAll(): void {
    this.notifyAll.set(!this.notifyAll());
    this.saveSettings();
  }

  protected toggleNotifyImportant(): void {
    this.notifyImportant.set(!this.notifyImportant());
    this.saveSettings();
  }

  protected toggleRule(id: string): void {
    this.rules.update((rules) =>
      rules.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule)),
    );
    this.saveSettings();
  }

  protected removeRule(id: string): void {
    this.rules.update((rules) => rules.filter((rule) => rule.id !== id));
    this.saveSettings();
  }

  protected addRule(): void {
    const text = this.newRuleText().trim();
    if (!text) return;
    const kind = this.newRuleKind();
    const rule: Rule = {
      id: `rule-${Date.now()}-${nextRuleId++}`,
      enabled: true,
      kind,
      ...(kind === 'label' ? { label: text } : { text }),
    };
    this.rules.update((rules) => [...rules, rule]);
    this.newRuleText.set('');
    this.saveSettings();
  }

  protected describeRule(rule: Rule): string {
    switch (rule.kind) {
      case 'fromContains':
        return `From contains "${rule.text}"`;
      case 'subjectContains':
        return `Subject contains "${rule.text}"`;
      case 'label':
        return `Has label "${rule.label}"`;
    }
  }

  protected saveSettings(): void {
    void this.tauri.gmailSetSettings({
      rules: {
        notifyAll: this.notifyAll(),
        notifyImportant: this.notifyImportant(),
        custom: this.rules(),
      },
      pollIntervalSecs: this.pollIntervalSecs(),
    });
  }
}
