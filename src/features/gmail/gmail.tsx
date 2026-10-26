import { Fragment } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/shared/icon';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useController, useSignals } from '@/lib/signals';
import { DestroyRef } from '@/lib/signals';
import { inject } from '@/lib/inject';
import { signal } from '@/lib/signals';

import { TauriBridge, type GmailStatus, type Rule, type RuleKind } from '@/core/tauri';

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

import './gmail.css';

export class GmailState {
  private readonly tauri = inject(TauriBridge);
  readonly destroyRef = new DestroyRef();

  readonly status = signal<GmailStatus>({
    connected: false,
    connecting: false,
    needsReconnect: false,
    accountEmail: null,
  });
  readonly busy = signal(false);
  readonly error = signal('');

  readonly notifyAll = signal(false);
  readonly notifyImportant = signal(true);
  readonly pollIntervalSecs = signal(60);
  readonly pollIntervalText = signal('60');
  readonly rules = signal<readonly Rule[]>([]);

  readonly newRuleKind = signal<RuleKind['kind']>('fromContains');
  readonly newRuleText = signal('');

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
      this.pollIntervalText.set(String(settings.pollIntervalSecs));
      this.rules.set(settings.rules.custom);
    }
  }

  async connect(): Promise<void> {
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

  async cancelConnect(): Promise<void> {
    await this.tauri.gmailCancelConnect();
  }

  async disconnect(): Promise<void> {
    this.busy.set(true);
    try {
      await this.tauri.gmailDisconnect();
      await this.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  setNotifyAll(value: boolean): void {
    this.notifyAll.set(value);
    this.saveSettings();
  }

  setNotifyImportant(value: boolean): void {
    this.notifyImportant.set(value);
    this.saveSettings();
  }

  savePollInterval(): void {
    const seconds = Number.parseInt(this.pollIntervalText(), 10);
    if (!Number.isFinite(seconds) || seconds < 30) {
      this.pollIntervalText.set(String(this.pollIntervalSecs()));
      return;
    }
    this.pollIntervalSecs.set(seconds);
    this.saveSettings();
  }

  setRuleEnabled(id: string, enabled: boolean): void {
    this.rules.update((rules) =>
      rules.map((rule) => (rule.id === id ? { ...rule, enabled } : rule)),
    );
    this.saveSettings();
  }

  removeRule(id: string): void {
    this.rules.update((rules) => rules.filter((rule) => rule.id !== id));
    this.saveSettings();
  }

  addRule(): void {
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

  describeRule(rule: Rule): string {
    switch (rule.kind) {
      case 'fromContains':
        return `From contains "${rule.text}"`;
      case 'subjectContains':
        return `Subject contains "${rule.text}"`;
      case 'label':
        return `Has label "${rule.label}"`;
    }
  }

  saveSettings(): void {
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

export function Gmail() {
  useSignals();
  const s = useController(() => new GmailState());
  return (
    <div className="gmail">
      <section className="group">
        <h2 className="u-caption">Gmail</h2>

        {s.status().connected ? (
          <>
            <div className="row">
              <div>
                <p className="label">{s.status().accountEmail}</p>
                <p className="hint">Polling every {s.pollIntervalSecs()}s for new inbox mail.</p>
              </div>
              <Button
                size="sm"
                variant="link"
                disabled={s.busy()}
                onClick={() => {
                  void s.disconnect();
                }}
              >
                Disconnect
              </Button>
            </div>

            <div className="row">
              <div>
                <p className="label">Notify on every new message</p>
                <p className="hint">
                  Off by default — only Gmail's Important label triggers a HUD notification.
                </p>
              </div>
              <Switch
                aria-label="Notify on every new message"
                checked={s.notifyAll()}
                onCheckedChange={($event) => {
                  void s.setNotifyAll($event);
                }}
              />
            </div>

            <div className="row">
              <div>
                <p className="label">Notify on Gmail's Important label</p>
                <p className="hint">Gmail's own priority-inbox signal.</p>
              </div>
              <Switch
                aria-label="Notify on Gmail's Important label"
                checked={s.notifyImportant()}
                onCheckedChange={($event) => {
                  void s.setNotifyImportant($event);
                }}
              />
            </div>

            <div className="row poll-row">
              <div>
                <p className="label">Poll interval</p>
                <p className="hint">How often to check for new mail, in seconds (minimum 30).</p>
              </div>
              <span className="poll-field">
                <Input
                  type="number"
                  min={30}
                  value={s.pollIntervalText()}
                  onValueChange={(value) => {
                    s.pollIntervalText.set(value);
                  }}
                  aria-label="Poll interval in seconds"
                  onBlur={() => {
                    void s.savePollInterval();
                  }}
                />
              </span>
            </div>

            <div className="rules">
              <p className="label">Custom rules</p>
              {s.rules().length === 0 ? (
                <>
                  <p className="hint">No custom rules yet.</p>
                </>
              ) : (
                <>
                  {s.rules().map((rule) => {
                    return (
                      <Fragment key={rule.id}>
                        <div className="rule">
                          <Switch
                            aria-label={s.describeRule(rule)}
                            checked={rule.enabled}
                            onCheckedChange={($event) => {
                              void s.setRuleEnabled(rule.id, $event);
                            }}
                          />
                          <span className="rule-text">{s.describeRule(rule)}</span>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Remove rule"
                            onClick={() => {
                              void s.removeRule(rule.id);
                            }}
                          >
                            <Icon name="trash-2" size={14} />
                          </Button>
                        </div>
                      </Fragment>
                    );
                  })}
                </>
              )}

              <form
                className="rule-form"
                onSubmit={($event) => {
                  $event.preventDefault();
                  void s.addRule();
                }}
              >
                <select
                  className="field"
                  value={s.newRuleKind()}
                  onChange={($event) => {
                    s.newRuleKind.set($event.currentTarget.value as RuleKind['kind']);
                  }}
                  name="newRuleKind"
                >
                  <option value="fromContains">From contains</option>
                  <option value="subjectContains">Subject contains</option>
                  <option value="label">Has label</option>
                </select>
                <span className="rule-input">
                  <Input
                    value={s.newRuleText()}
                    onValueChange={(value) => {
                      s.newRuleText.set(value);
                    }}
                    placeholder={s.newRuleKind() === 'label' ? 'STARRED' : 'e.g. boss@work.com'}
                    required={true}
                  />
                </span>
                <Button size="sm" variant="link" type="submit" disabled={!s.newRuleText().trim()}>
                  Add
                </Button>
              </form>
            </div>
          </>
        ) : s.status().connecting ? (
          <>
            <div className="row">
              <div>
                <p className="label">Waiting for the browser</p>
                <p className="hint">Complete sign-in in the window Relay just opened.</p>
              </div>
              <Button
                size="sm"
                variant="link"
                onClick={() => {
                  void s.cancelConnect();
                }}
              >
                Cancel
              </Button>
            </div>
          </>
        ) : s.status().needsReconnect ? (
          <>
            <div className="row">
              <div>
                <p className="label">Reconnect Gmail</p>
                <p className="hint">
                  The saved sign-in expired or was revoked. Sign in again to resume polling.
                </p>
              </div>
              <Button
                size="sm"
                variant="link"
                disabled={s.busy()}
                onClick={() => {
                  void s.connect();
                }}
              >
                Reconnect
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="row">
              <div>
                <p className="label">Not connected</p>
                <p className="hint">Get a HUD notification for important new mail.</p>
              </div>
              <Button
                size="sm"
                variant="link"
                disabled={s.busy()}
                onClick={() => {
                  void s.connect();
                }}
              >
                Connect Gmail
              </Button>
            </div>
          </>
        )}

        {s.error() ? (
          <>
            <p className="error">{s.error()}</p>
          </>
        ) : null}
      </section>
    </div>
  );
}
