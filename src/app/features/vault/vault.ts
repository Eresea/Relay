import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TauriBridge, type PasswordOptions, type VaultEntrySummary } from '@core/tauri';
import { Icon } from '@shared/icon';

/**
 * Relay's password vault, reached from the palette's "Password vault"
 * command. Entries are decrypted core-side and never touch disk in
 * plaintext (see `src-tauri/src/vault.rs`); this component only ever holds
 * summaries — a password crosses IPC again, on demand, when revealed.
 */
@Component({
  selector: 'rl-vault',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Icon],
  template: `
    <section class="wrap">
      @if (status() === 'unlocked') {
        <section class="group">
          <h2 class="u-caption">Generate a password</h2>
          <div class="generated-row">
            <code class="generated">{{ generated() || 'Press generate' }}</code>
            <button type="button" class="icon-btn" (click)="regenerate()" aria-label="Generate">
              <rl-icon name="loader-circle" [size]="16" />
            </button>
            <button
              type="button"
              class="icon-btn"
              [disabled]="!generated()"
              (click)="copyGenerated()"
              [attr.aria-label]="copiedId() === 'generated' ? 'Copied' : 'Copy password'"
            >
              <rl-icon [name]="copiedId() === 'generated' ? 'check' : 'copy'" [size]="16" />
            </button>
          </div>

          <div class="options">
            <label class="option">
              <span>Length</span>
              <input
                type="number"
                min="4"
                max="128"
                [(ngModel)]="length"
                (ngModelChange)="regenerate()"
              />
            </label>
            <label class="check">
              <input type="checkbox" [(ngModel)]="upper" (ngModelChange)="regenerate()" />
              <span>ABC</span>
            </label>
            <label class="check">
              <input type="checkbox" [(ngModel)]="lower" (ngModelChange)="regenerate()" />
              <span>abc</span>
            </label>
            <label class="check">
              <input type="checkbox" [(ngModel)]="digits" (ngModelChange)="regenerate()" />
              <span>123</span>
            </label>
            <label class="check">
              <input type="checkbox" [(ngModel)]="symbols" (ngModelChange)="regenerate()" />
              <span>#!$</span>
            </label>
          </div>

          <form class="entry-form" (ngSubmit)="saveEntry()">
            <input
              class="field"
              placeholder="Account (e.g. GitHub)"
              [(ngModel)]="label"
              name="label"
              required
            />
            <input
              class="field"
              placeholder="Username or email"
              [(ngModel)]="username"
              name="username"
            />
            <input class="field" placeholder="URL (optional)" [(ngModel)]="url" name="url" />
            <button type="submit" class="primary" [disabled]="!generated() || !label() || saving()">
              Save to vault
            </button>
          </form>
        </section>

        <section class="group">
          <div class="row-header">
            <h2 class="u-caption">Entries</h2>
            <div class="header-actions">
              <button type="button" class="link" (click)="export()">Export</button>
              <button type="button" class="link" (click)="lock()">Lock</button>
            </div>
          </div>

          @if (exportPath()) {
            <p class="hint export-hint">Exported to {{ exportPath() }}</p>
          }

          @if (entries().length === 0) {
            <p class="hint">No saved accounts yet.</p>
          } @else {
            @for (entry of entries(); track entry.id) {
              <div class="entry">
                <div class="entry-main">
                  <p class="label">{{ entry.label }}</p>
                  <p class="hint">{{ entry.username || entry.url || 'No details' }}</p>
                </div>
                <div class="entry-actions">
                  <code class="revealed">{{ revealedFor(entry.id) }}</code>
                  <button
                    type="button"
                    class="icon-btn"
                    (click)="toggleReveal(entry.id)"
                    [attr.aria-label]="
                      revealedId() === entry.id ? 'Hide password' : 'Reveal password'
                    "
                  >
                    <rl-icon [name]="revealedId() === entry.id ? 'eye-off' : 'eye'" [size]="16" />
                  </button>
                  <button
                    type="button"
                    class="icon-btn"
                    (click)="copyEntry(entry.id)"
                    [attr.aria-label]="copiedId() === entry.id ? 'Copied' : 'Copy password'"
                  >
                    <rl-icon [name]="copiedId() === entry.id ? 'check' : 'copy'" [size]="16" />
                  </button>
                  <button
                    type="button"
                    class="icon-btn danger"
                    (click)="deleteEntry(entry.id)"
                    aria-label="Delete entry"
                  >
                    <rl-icon name="trash-2" [size]="16" />
                  </button>
                </div>
              </div>
            }
          }
        </section>
      } @else if (status() === 'locked') {
        <form class="unlock" (ngSubmit)="unlock()">
          <rl-icon name="lock" [size]="20" />
          <p class="u-title">Vault is locked</p>
          <input
            class="field"
            type="password"
            placeholder="Master password"
            [(ngModel)]="masterPassword"
            name="masterPassword"
          />
          @if (error()) {
            <p class="error">{{ error() }}</p>
          }
          <button type="submit" class="primary" [disabled]="busy()">Unlock</button>
        </form>
      } @else if (status() === 'missing') {
        <form class="unlock" (ngSubmit)="create()">
          <rl-icon name="lock" [size]="20" />
          <p class="u-title">Create your vault</p>
          <p class="hint">Choose a master password. There is no way to recover it if it is lost.</p>
          <input
            class="field"
            type="password"
            placeholder="Master password (min. 8 characters)"
            [(ngModel)]="masterPassword"
            name="masterPassword"
          />
          <input
            class="field"
            type="password"
            placeholder="Confirm master password"
            [(ngModel)]="confirmPassword"
            name="confirmPassword"
          />
          @if (error()) {
            <p class="error">{{ error() }}</p>
          }
          <button type="submit" class="primary" [disabled]="busy()">Create vault</button>
        </form>
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
    }

    .header-actions {
      display: flex;
      gap: var(--space-2);
    }

    .generated-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-block-end: var(--space-4);
    }

    .generated {
      flex: 1;
      padding: var(--space-3) var(--space-4);
      font-size: var(--text-13);
      background: var(--bg-sunken);
      border-radius: var(--radius-sm);
      overflow-x: auto;
      white-space: nowrap;
    }

    .options {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-4);
      margin-block-end: var(--space-5);
      font-size: var(--text-13);
      color: var(--text-muted);
    }

    .option {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .option input {
      inline-size: 4.5em;
    }

    .check {
      display: flex;
      align-items: center;
      gap: var(--space-1);
    }

    .entry-form {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }

    .field {
      padding: var(--space-3) var(--space-4);
      font-size: var(--text-13);
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      color: var(--text-body);
    }

    .primary {
      align-self: flex-start;
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

    .link {
      font-size: var(--text-13);
      color: var(--accent);
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-sm);
    }

    .link:hover {
      background: var(--tint-hover);
    }

    .entry {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      padding: var(--space-4) 0;
      border-block-end: 1px solid var(--border-subtle);
    }

    .entry:last-child {
      border-block-end: none;
    }

    .entry-main .label {
      margin: 0;
      font-size: var(--text-13);
      color: var(--text-body);
    }

    .entry-main .hint {
      margin: var(--space-1) 0 0;
    }

    .entry-actions {
      display: flex;
      align-items: center;
      gap: var(--space-1);
    }

    .revealed {
      font-size: var(--text-12);
      color: var(--text-muted);
      max-inline-size: 10em;
      overflow: hidden;
      text-overflow: ellipsis;
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

    .hint {
      margin: var(--space-1) 0 0;
      font-size: var(--text-12);
      color: var(--text-muted);
    }

    .export-hint {
      margin-block-end: var(--space-3);
    }

    .unlock {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-3);
      max-inline-size: 22em;
      margin: var(--space-10) auto 0;
      text-align: center;
    }

    .unlock .field {
      inline-size: 100%;
    }

    .error {
      margin: 0;
      font-size: var(--text-12);
      color: var(--danger-ink);
    }
  `,
})
export class Vault {
  private readonly tauri = inject(TauriBridge);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly status = signal<'loading' | 'missing' | 'locked' | 'unlocked'>('loading');
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected readonly masterPassword = signal('');
  protected readonly confirmPassword = signal('');

  protected readonly entries = signal<readonly VaultEntrySummary[]>([]);
  protected readonly revealedId = signal<string | null>(null);
  protected readonly revealedPassword = signal('');
  protected readonly exportPath = signal('');

  protected readonly generated = signal('');
  protected readonly copiedId = signal<string | null>(null);
  private copyTimeout: ReturnType<typeof setTimeout> | null = null;
  protected readonly length = signal(20);
  protected readonly upper = signal(true);
  protected readonly lower = signal(true);
  protected readonly digits = signal(true);
  protected readonly symbols = signal(true);

  protected readonly label = signal('');
  protected readonly username = signal('');
  protected readonly url = signal('');
  protected readonly saving = signal(false);

  constructor() {
    void this.refreshStatus();

    void this.tauri
      .onEvent((event) => {
        if (event.type === 'openVaultRequested') void this.refreshStatus();
      })
      .then((unlisten) => this.destroyRef.onDestroy(unlisten));

    this.destroyRef.onDestroy(() => {
      if (this.copyTimeout) clearTimeout(this.copyTimeout);
    });
  }

  private async refreshStatus(): Promise<void> {
    const result = await this.tauri.vaultStatus();
    if (!result.exists) {
      this.status.set('missing');
    } else if (!result.unlocked) {
      this.status.set('locked');
    } else {
      this.status.set('unlocked');
      await this.loadEntries();
      this.regenerate();
    }
  }

  private async loadEntries(): Promise<void> {
    this.entries.set(await this.tauri.vaultListEntries());
  }

  protected async create(): Promise<void> {
    this.error.set('');
    if (this.masterPassword() !== this.confirmPassword()) {
      this.error.set('Passwords do not match.');
      return;
    }
    this.busy.set(true);
    try {
      await this.tauri.vaultCreate(this.masterPassword());
      this.masterPassword.set('');
      this.confirmPassword.set('');
      await this.refreshStatus();
    } catch {
      this.error.set('Could not create the vault.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async unlock(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.tauri.vaultUnlock(this.masterPassword());
      this.masterPassword.set('');
      await this.refreshStatus();
    } catch {
      this.error.set('Wrong master password.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async lock(): Promise<void> {
    await this.tauri.vaultLock();
    this.entries.set([]);
    this.revealedId.set(null);
    this.exportPath.set('');
    this.status.set('locked');
  }

  protected regenerate(): void {
    void this.tauri
      .generatePassword({
        length: this.length(),
        upper: this.upper(),
        lower: this.lower(),
        digits: this.digits(),
        symbols: this.symbols(),
      } satisfies PasswordOptions)
      .then((password) => this.generated.set(password))
      .catch(() => this.generated.set(''));
  }

  protected async saveEntry(): Promise<void> {
    if (!this.generated() || !this.label()) return;
    this.saving.set(true);
    try {
      await this.tauri.vaultAddEntry({
        label: this.label(),
        username: this.username(),
        password: this.generated(),
        ...(this.url() ? { url: this.url() } : {}),
      });
      this.label.set('');
      this.username.set('');
      this.url.set('');
      this.regenerate();
      await this.loadEntries();
    } finally {
      this.saving.set(false);
    }
  }

  protected async deleteEntry(id: string): Promise<void> {
    await this.tauri.vaultDeleteEntry(id);
    if (this.revealedId() === id) this.revealedId.set(null);
    await this.loadEntries();
  }

  protected toggleReveal(id: string): void {
    if (this.revealedId() === id) {
      this.revealedId.set(null);
      return;
    }
    void this.tauri.vaultRevealPassword(id).then((password) => {
      this.revealedPassword.set(password);
      this.revealedId.set(id);
    });
  }

  protected revealedFor(id: string): string {
    return this.revealedId() === id ? this.revealedPassword() : '••••••••';
  }

  protected copyGenerated(): void {
    if (!this.generated()) return;
    this.copy(this.generated(), 'generated');
  }

  protected copyEntry(id: string): void {
    void this.tauri.vaultRevealPassword(id).then((password) => this.copy(password, id));
  }

  protected copy(value: string, id?: string): void {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    if (id) {
      if (this.copyTimeout) clearTimeout(this.copyTimeout);
      this.copiedId.set(id);
      this.copyTimeout = setTimeout(() => this.copiedId.set(null), 2000);
    }
  }

  protected async export(): Promise<void> {
    this.exportPath.set(await this.tauri.vaultExport());
  }
}
