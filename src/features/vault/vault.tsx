import { Fragment, useRef } from 'react';
import { Icon } from '@/shared/icon';
import { cn } from '@/lib/utils';
import { useController, useSignals } from '@/lib/signals';
import { DestroyRef } from '@/lib/signals';
import { inject } from '@/lib/inject';
import { computed, signal } from '@/lib/signals';

import {
  TauriBridge,
  type OpenCloudItem,
  type OpenCloudStatus,
  type PasswordOptions,
  type VaultEntrySummary,
  type VaultSyncRevision,
} from '@/core/tauri';

/**
 * Relay's password vault, reached from the palette's "Password vault"
 * command. Entries are decrypted core-side and never touch disk in
 * plaintext (see `src-tauri/src/vault.rs`); this component only ever holds
 * summaries — a password crosses IPC again, on demand, when revealed.
 */

import './vault.css';

export class VaultState {
  private readonly tauri = inject(TauriBridge);
  readonly destroyRef = new DestroyRef();

  readonly status = signal<'loading' | 'missing' | 'locked' | 'unlocked'>('loading');
  readonly view = signal<'credentials' | 'files'>('credentials');
  readonly busy = signal(false);
  readonly error = signal('');

  readonly masterPassword = signal('');
  readonly confirmPassword = signal('');

  readonly entries = signal<readonly VaultEntrySummary[]>([]);
  readonly revealedId = signal<string | null>(null);
  readonly revealedPassword = signal('');
  readonly pendingDeleteId = signal<string | null>(null);
  readonly exportPath = signal('');
  readonly remoteVault = signal<VaultSyncRevision | null>(null);
  readonly remoteChecked = signal(false);
  readonly syncPassword = signal('');
  readonly syncMessage = signal('');

  readonly generated = signal('');
  readonly copiedId = signal<string | null>(null);
  private copyTimeout: ReturnType<typeof setTimeout> | null = null;
  readonly length = signal(20);
  readonly upper = signal(true);
  readonly lower = signal(true);
  readonly digits = signal(true);
  readonly symbols = signal(true);

  readonly label = signal('');
  readonly username = signal('');
  readonly url = signal('');
  readonly saving = signal(false);

  readonly openCloud = signal<OpenCloudStatus>({
    connected: false,
    webdavUrl: null,
    username: null,
  });
  readonly cloudItems = signal<readonly OpenCloudItem[]>([]);
  readonly cloudBusy = signal(false);
  readonly cloudError = signal('');
  readonly pendingFileDelete = signal<string | null>(null);
  readonly webdavUrl = signal('');
  readonly cloudUsername = signal('');
  readonly appToken = signal('');
  readonly newFolderName = signal('');
  readonly currentFolder = signal('');
  readonly breadcrumbs = computed(() => {
    const parts = this.currentFolder().split('/').filter(Boolean);
    return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
  });

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
      const cloud = await this.tauri.openCloudStatus();
      this.openCloud.set(cloud);
      this.webdavUrl.set(cloud.webdavUrl ?? '');
      this.cloudUsername.set(cloud.username ?? '');
      if (this.view() === 'files' && this.openCloud().connected)
        await this.loadFiles(this.currentFolder());
    }
  }

  private async loadEntries(): Promise<void> {
    this.entries.set(await this.tauri.vaultListEntries());
  }

  async checkRemoteVault(): Promise<void> {
    this.busy.set(true);
    this.syncMessage.set('');
    try {
      this.remoteVault.set(await this.tauri.nexusVaultLatest());
      this.remoteChecked.set(true);
      this.syncMessage.set(
        this.remoteVault()
          ? 'Remote copy found. Review before choosing a direction.'
          : 'No remote copy exists yet.',
      );
    } catch (error) {
      this.syncMessage.set(
        this.errorMessage(error, 'Could not check Nexus. Sign in to Nexus and try again.'),
      );
    } finally {
      this.busy.set(false);
    }
  }

  async uploadVault(): Promise<void> {
    this.busy.set(true);
    try {
      const result = await this.tauri.nexusVaultUpload(this.remoteVault()?.revisionId ?? null);
      if (result?.kind === 'conflict') {
        this.syncMessage.set(
          'The remote copy changed. Check Nexus again and review before retrying.',
        );
      } else if (result?.kind === 'saved') {
        this.remoteVault.set(result.value);
        this.remoteChecked.set(true);
        this.syncMessage.set('Encrypted vault uploaded.');
      }
    } catch (error) {
      this.syncMessage.set(this.errorMessage(error, 'Could not upload the vault.'));
    } finally {
      this.busy.set(false);
    }
  }

  async restoreRemoteVault(): Promise<void> {
    const remote = this.remoteVault();
    if (!remote || !this.syncPassword()) return;
    if (!window.confirm('Replace this device’s entire password vault with the remote copy?'))
      return;
    this.busy.set(true);
    try {
      await this.tauri.vaultApplySync(remote.ciphertext, this.syncPassword());
      this.syncPassword.set('');
      await this.loadEntries();
      this.syncMessage.set('Remote copy restored on this device.');
    } catch (error) {
      this.syncMessage.set(
        this.errorMessage(error, 'Could not restore the remote copy. Check the master password.'),
      );
    } finally {
      this.busy.set(false);
    }
  }

  async create(): Promise<void> {
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

  async unlock(): Promise<void> {
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

  async lock(): Promise<void> {
    await this.tauri.vaultLock();
    this.entries.set([]);
    this.revealedId.set(null);
    this.pendingDeleteId.set(null);
    this.exportPath.set('');
    this.cloudItems.set([]);
    this.status.set('locked');
  }

  showFiles(): void {
    this.view.set('files');
    if (this.openCloud().connected) void this.loadFiles(this.currentFolder());
    else void this.tauri.openCloudStatus().then((status) => this.openCloud.set(status));
  }

  async connectOpenCloud(): Promise<void> {
    this.cloudError.set('');
    this.cloudBusy.set(true);
    try {
      await this.tauri.openCloudConnect(this.webdavUrl(), this.cloudUsername(), this.appToken());
      this.appToken.set('');
      this.openCloud.set(await this.tauri.openCloudStatus());
      await this.loadFiles('');
    } catch (error) {
      this.cloudError.set(this.errorMessage(error, 'Could not connect to OpenCloud.'));
    } finally {
      this.cloudBusy.set(false);
    }
  }

  async disconnectOpenCloud(): Promise<void> {
    await this.tauri.openCloudDisconnect();
    this.openCloud.set({ connected: false, webdavUrl: null, username: null });
    this.cloudItems.set([]);
    this.currentFolder.set('');
  }

  async loadFiles(path: string): Promise<void> {
    this.cloudError.set('');
    this.cloudBusy.set(true);
    try {
      this.cloudItems.set(await this.tauri.openCloudList(path));
      this.currentFolder.set(path);
      this.pendingFileDelete.set(null);
    } catch (error) {
      this.cloudError.set(this.errorMessage(error, 'Could not load OpenCloud files.'));
    } finally {
      this.cloudBusy.set(false);
    }
  }

  async createFolder(): Promise<void> {
    this.cloudError.set('');
    this.cloudBusy.set(true);
    try {
      await this.tauri.openCloudCreateFolder(this.currentFolder(), this.newFolderName());
      this.newFolderName.set('');
      this.cloudItems.set(await this.tauri.openCloudList(this.currentFolder()));
    } catch (error) {
      this.cloudError.set(this.errorMessage(error, 'Could not create the folder.'));
    } finally {
      this.cloudBusy.set(false);
    }
  }

  async uploadFiles(input: HTMLInputElement): Promise<void> {
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    this.cloudError.set('');
    this.cloudBusy.set(true);
    try {
      for (const file of files) {
        await this.tauri.openCloudUpload(
          this.currentFolder(),
          file.name,
          file.type || 'application/octet-stream',
          await this.toBase64(file),
        );
      }
      this.cloudItems.set(await this.tauri.openCloudList(this.currentFolder()));
    } catch (error) {
      this.cloudError.set(this.errorMessage(error, 'Could not upload the selected files.'));
      this.cloudItems.set(
        await this.tauri.openCloudList(this.currentFolder()).catch(() => this.cloudItems()),
      );
    } finally {
      input.value = '';
      this.cloudBusy.set(false);
    }
  }

  async downloadFile(item: OpenCloudItem): Promise<void> {
    this.cloudError.set('');
    this.cloudBusy.set(true);
    try {
      const encoded = await this.tauri.openCloudDownload(item.path);
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(
        new Blob([bytes], { type: item.mediaType ?? 'application/octet-stream' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = item.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      this.cloudError.set(this.errorMessage(error, 'Could not download the file.'));
    } finally {
      this.cloudBusy.set(false);
    }
  }

  async deleteFile(path: string): Promise<void> {
    this.cloudError.set('');
    this.cloudBusy.set(true);
    try {
      await this.tauri.openCloudDelete(path);
      this.cloudItems.set(await this.tauri.openCloudList(this.currentFolder()));
      this.pendingFileDelete.set(null);
    } catch (error) {
      this.cloudError.set(this.errorMessage(error, 'Could not delete the file.'));
    } finally {
      this.cloudBusy.set(false);
    }
  }

  private async toBase64(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    return btoa(chunks.join(''));
  }

  private errorMessage(error: unknown, fallback: string): string {
    if (typeof error === 'string') return error;
    return error instanceof Error ? error.message : fallback;
  }

  formatSize(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  regenerate(): void {
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

  async saveEntry(): Promise<void> {
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

  requestDelete(id: string): void {
    this.pendingDeleteId.set(id);
  }

  cancelDelete(): void {
    this.pendingDeleteId.set(null);
  }

  confirmDelete(id: string): void {
    void this.deleteEntry(id);
  }

  async deleteEntry(id: string): Promise<void> {
    await this.tauri.vaultDeleteEntry(id);
    if (this.revealedId() === id) this.revealedId.set(null);
    if (this.pendingDeleteId() === id) this.pendingDeleteId.set(null);
    await this.loadEntries();
  }

  toggleReveal(id: string): void {
    if (this.revealedId() === id) {
      this.revealedId.set(null);
      return;
    }
    void this.tauri.vaultRevealPassword(id).then((password) => {
      this.revealedPassword.set(password);
      this.revealedId.set(id);
    });
  }

  revealedFor(id: string): string {
    return this.revealedId() === id ? this.revealedPassword() : '••••••••';
  }

  copyGenerated(): void {
    if (!this.generated()) return;
    this.copy(this.generated(), 'generated');
  }

  copyEntry(id: string): void {
    void this.tauri.vaultRevealPassword(id).then((password) => this.copy(password, id));
  }

  copy(value: string, id?: string): void {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    if (id) {
      if (this.copyTimeout) clearTimeout(this.copyTimeout);
      this.copiedId.set(id);
      this.copyTimeout = setTimeout(() => this.copiedId.set(null), 2000);
    }
  }

  async export(): Promise<void> {
    this.exportPath.set(await this.tauri.vaultExport());
  }
}

export default function Vault() {
  useSignals();
  const s = useController(() => new VaultState());
  const filePicker = useRef<HTMLInputElement>(null);
  return (
    <div className="vault">
      <section className="wrap">
        {s.status() === 'unlocked' ? (
          <>
            <nav className="tabs" aria-label="Vault sections">
              <button
                className={cn(s.view() === 'credentials' && 'active')}
                type="button"
                onClick={() => {
                  void s.view.set('credentials');
                }}
              >
                <Icon name="key-round" size={16} /> Credentials
              </button>
              <button
                className={cn(s.view() === 'files' && 'active')}
                type="button"
                onClick={() => {
                  void s.showFiles();
                }}
              >
                <Icon name="folder" size={16} /> Files
              </button>
            </nav>

            {s.view() === 'credentials' ? (
              <>
                <section className="group">
                  <h2 className="u-caption">Sync encrypted vault</h2>
                  <p className="hint">
                    Nexus stores only the encrypted vault. Check for a remote copy before uploading
                    or replacing this device's copy.
                  </p>
                  {s.syncMessage() ? (
                    <>
                      <p className="hint">{s.syncMessage()}</p>
                    </>
                  ) : null}
                  {s.remoteVault() ? (
                    <>
                      <p className="hint">
                        Restoring replaces every credential on this device. Keep a separate export
                        if you need both copies.
                      </p>
                      <input
                        className="field"
                        type="password"
                        placeholder="Master password to restore this copy"
                        value={s.syncPassword()}
                        onChange={($event) => {
                          s.syncPassword.set($event.currentTarget.value);
                        }}
                        name="syncPassword"
                      />
                      <button
                        className="link"
                        type="button"
                        disabled={s.busy() || !s.syncPassword()}
                        onClick={() => {
                          void s.restoreRemoteVault();
                        }}
                      >
                        Replace this vault with the remote copy
                      </button>
                    </>
                  ) : null}
                  <div className="header-actions">
                    <button
                      className="link"
                      type="button"
                      disabled={s.busy()}
                      onClick={() => {
                        void s.checkRemoteVault();
                      }}
                    >
                      Check Nexus
                    </button>
                    <button
                      className="link"
                      type="button"
                      disabled={s.busy() || !s.remoteChecked()}
                      onClick={() => {
                        void s.uploadVault();
                      }}
                    >
                      Upload this copy
                    </button>
                  </div>
                </section>

                <section className="group">
                  <h2 className="u-caption">Generate a password</h2>
                  <div className="generated-row">
                    <code className="generated">{s.generated() || 'Press generate'}</code>
                    <button
                      className="icon-btn"
                      type="button"
                      onClick={() => {
                        void s.regenerate();
                      }}
                      aria-label="Generate"
                    >
                      <Icon name="loader-circle" size={16} />
                    </button>
                    <button
                      className="icon-btn"
                      type="button"
                      disabled={!s.generated()}
                      onClick={() => {
                        void s.copyGenerated();
                      }}
                      aria-label={s.copiedId() === 'generated' ? 'Copied' : 'Copy password'}
                    >
                      <Icon name={s.copiedId() === 'generated' ? 'check' : 'copy'} size={16} />
                    </button>
                  </div>

                  <div className="options">
                    <label className="option">
                      <span>Length</span>
                      <input
                        type="number"
                        min="4"
                        max="128"
                        value={s.length()}
                        onChange={($event) => {
                          s.length.set($event.currentTarget.valueAsNumber);
                          void s.regenerate();
                        }}
                      />
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={s.upper()}
                        onChange={($event) => {
                          s.upper.set($event.currentTarget.checked);
                          void s.regenerate();
                        }}
                      />
                      <span>ABC</span>
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={s.lower()}
                        onChange={($event) => {
                          s.lower.set($event.currentTarget.checked);
                          void s.regenerate();
                        }}
                      />
                      <span>abc</span>
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={s.digits()}
                        onChange={($event) => {
                          s.digits.set($event.currentTarget.checked);
                          void s.regenerate();
                        }}
                      />
                      <span>123</span>
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={s.symbols()}
                        onChange={($event) => {
                          s.symbols.set($event.currentTarget.checked);
                          void s.regenerate();
                        }}
                      />
                      <span>#!$</span>
                    </label>
                  </div>

                  <form
                    className="entry-form"
                    onSubmit={($event) => {
                      $event.preventDefault();
                      void s.saveEntry();
                    }}
                  >
                    <input
                      className="field"
                      placeholder="Account (e.g. GitHub)"
                      value={s.label()}
                      onChange={($event) => {
                        s.label.set($event.currentTarget.value);
                      }}
                      name="label"
                      required
                    />
                    <input
                      className="field"
                      placeholder="Username or email"
                      value={s.username()}
                      onChange={($event) => {
                        s.username.set($event.currentTarget.value);
                      }}
                      name="username"
                    />
                    <input
                      className="field"
                      placeholder="URL (optional)"
                      value={s.url()}
                      onChange={($event) => {
                        s.url.set($event.currentTarget.value);
                      }}
                      name="url"
                    />
                    <button
                      className="primary"
                      type="submit"
                      disabled={!s.generated() || !s.label() || s.saving()}
                    >
                      Save to vault
                    </button>
                  </form>
                </section>

                <section className="group">
                  <div className="row-header">
                    <h2 className="u-caption">Entries</h2>
                    <div className="header-actions">
                      <button
                        className="link"
                        type="button"
                        onClick={() => {
                          void s.export();
                        }}
                      >
                        Export
                      </button>
                      <button
                        className="link"
                        type="button"
                        onClick={() => {
                          void s.lock();
                        }}
                      >
                        Lock
                      </button>
                    </div>
                  </div>

                  {s.exportPath() ? (
                    <>
                      <p className="hint export-hint">Exported to {s.exportPath()}</p>
                    </>
                  ) : null}

                  {s.entries().length === 0 ? (
                    <>
                      <p className="hint">No saved accounts yet.</p>
                    </>
                  ) : (
                    <>
                      {s.entries().map((entry) => {
                        return (
                          <Fragment key={entry.id}>
                            <div className="entry">
                              <div className="entry-main">
                                <p className="label">{entry.label}</p>
                                <p className="hint">
                                  {entry.username || entry.url || 'No details'}
                                </p>
                              </div>
                              <div className="entry-actions">
                                <code className="revealed">{s.revealedFor(entry.id)}</code>
                                <button
                                  className="icon-btn"
                                  type="button"
                                  onClick={() => {
                                    void s.toggleReveal(entry.id);
                                  }}
                                  aria-label={
                                    s.revealedId() === entry.id
                                      ? 'Hide password'
                                      : 'Reveal password'
                                  }
                                >
                                  <Icon
                                    name={s.revealedId() === entry.id ? 'eye-off' : 'eye'}
                                    size={16}
                                  />
                                </button>
                                <button
                                  className="icon-btn"
                                  type="button"
                                  onClick={() => {
                                    void s.copyEntry(entry.id);
                                  }}
                                  aria-label={
                                    s.copiedId() === entry.id ? 'Copied' : 'Copy password'
                                  }
                                >
                                  <Icon
                                    name={s.copiedId() === entry.id ? 'check' : 'copy'}
                                    size={16}
                                  />
                                </button>
                                {s.pendingDeleteId() === entry.id ? (
                                  <>
                                    <button
                                      className="confirm-delete-btn"
                                      type="button"
                                      onClick={() => {
                                        void s.confirmDelete(entry.id);
                                      }}
                                      aria-label="Confirm deleting entry"
                                    >
                                      Delete?
                                    </button>
                                    <button
                                      className="icon-btn"
                                      type="button"
                                      onClick={() => {
                                        void s.cancelDelete();
                                      }}
                                      aria-label="Cancel deleting entry"
                                    >
                                      <Icon name="x" size={16} />
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button
                                      className="icon-btn danger"
                                      type="button"
                                      onClick={() => {
                                        void s.requestDelete(entry.id);
                                      }}
                                      aria-label="Delete entry"
                                    >
                                      <Icon name="trash-2" size={16} />
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          </Fragment>
                        );
                      })}
                    </>
                  )}
                </section>
              </>
            ) : !s.openCloud().connected ? (
              <>
                <section className="group connect-panel">
                  <h2 className="u-caption">Connect OpenCloud</h2>
                  <p className="hint">
                    Enter a WebDAV URL for the space or folder you want to manage.
                  </p>
                  <form
                    className="entry-form"
                    onSubmit={($event) => {
                      $event.preventDefault();
                      void s.connectOpenCloud();
                    }}
                  >
                    <input
                      className="field"
                      type="url"
                      placeholder="WebDAV URL"
                      value={s.webdavUrl()}
                      onChange={($event) => {
                        s.webdavUrl.set($event.currentTarget.value);
                      }}
                      name="webdavUrl"
                      required
                    />
                    <input
                      className="field"
                      placeholder="Username"
                      value={s.cloudUsername()}
                      onChange={($event) => {
                        s.cloudUsername.set($event.currentTarget.value);
                      }}
                      name="cloudUsername"
                      required
                    />
                    <input
                      className="field"
                      type="password"
                      placeholder="OpenCloud app token"
                      value={s.appToken()}
                      onChange={($event) => {
                        s.appToken.set($event.currentTarget.value);
                      }}
                      name="appToken"
                      required
                    />
                    <p className="hint">
                      Create a dedicated app token in OpenCloud account settings. Relay stores it in
                      your system keychain.
                    </p>
                    {s.cloudError() ? (
                      <>
                        <p className="error">{s.cloudError()}</p>
                      </>
                    ) : null}
                    <button className="primary" type="submit" disabled={s.cloudBusy()}>
                      Connect
                    </button>
                  </form>
                </section>
              </>
            ) : (
              <>
                <section className="group files-panel">
                  <div className="row-header">
                    <div>
                      <h2 className="u-caption">Files</h2>
                      <div className="breadcrumbs">
                        <button
                          className="link"
                          type="button"
                          onClick={() => {
                            void s.loadFiles('');
                          }}
                        >
                          Files
                        </button>
                        {s.breadcrumbs().map((crumb) => {
                          return (
                            <Fragment key={crumb.path}>
                              <span aria-hidden="true">/</span>
                              <button
                                className="link"
                                type="button"
                                onClick={() => {
                                  void s.loadFiles(crumb.path);
                                }}
                              >
                                {crumb.name}
                              </button>
                            </Fragment>
                          );
                        })}
                      </div>
                      <p className="hint">
                        New uploads are encrypted with your vault password; file and folder names
                        stay visible in OpenCloud.
                      </p>
                    </div>
                    <div className="header-actions">
                      <button
                        className="link"
                        type="button"
                        onClick={() => {
                          void s.disconnectOpenCloud();
                        }}
                      >
                        Disconnect
                      </button>
                      <button
                        className="link"
                        type="button"
                        onClick={() => {
                          void s.lock();
                        }}
                      >
                        Lock
                      </button>
                    </div>
                  </div>

                  <div className="file-tools">
                    <form
                      className="folder-form"
                      onSubmit={($event) => {
                        $event.preventDefault();
                        void s.createFolder();
                      }}
                    >
                      <input
                        className="field"
                        placeholder="New folder"
                        value={s.newFolderName()}
                        onChange={($event) => {
                          s.newFolderName.set($event.currentTarget.value);
                        }}
                        name="newFolderName"
                        required
                      />
                      <button className="link" type="submit" disabled={s.cloudBusy()}>
                        Create folder
                      </button>
                    </form>
                    <input
                      className="file-picker"
                      ref={filePicker}
                      type="file"
                      multiple
                      onChange={($event) => void s.uploadFiles($event.currentTarget)}
                    />
                    <button
                      className="primary"
                      type="button"
                      onClick={() => filePicker.current?.click()}
                      disabled={s.cloudBusy()}
                    >
                      Upload files
                    </button>
                  </div>

                  {s.cloudError() ? (
                    <>
                      <p className="error">{s.cloudError()}</p>
                    </>
                  ) : null}
                  {s.cloudBusy() ? (
                    <>
                      <p className="hint">Working with OpenCloud…</p>
                    </>
                  ) : null}
                  {!s.cloudBusy() && s.cloudItems().length === 0 ? (
                    <>
                      <p className="hint">This folder is empty.</p>
                    </>
                  ) : null}
                  {s.cloudItems().map((item) => {
                    return (
                      <Fragment key={item.path}>
                        <div className="file-row">
                          <button
                            className="file-name"
                            type="button"
                            onClick={() => {
                              void (item.isFolder ? s.loadFiles(item.path) : s.downloadFile(item));
                            }}
                          >
                            <Icon name={item.isFolder ? 'folder' : 'file'} size={16} />
                            <span>{item.name}</span>
                          </button>
                          <span className="file-size">
                            {item.isFolder ? '' : s.formatSize(item.size)}
                          </span>
                          {s.pendingFileDelete() === item.path ? (
                            <>
                              <button
                                className="confirm-delete-btn"
                                type="button"
                                onClick={() => {
                                  void s.deleteFile(item.path);
                                }}
                              >
                                Delete?
                              </button>
                              <button
                                className="icon-btn"
                                type="button"
                                onClick={() => {
                                  void s.pendingFileDelete.set(null);
                                }}
                                aria-label="Cancel deleting file"
                              >
                                <Icon name="x" size={16} />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="icon-btn danger"
                                type="button"
                                onClick={() => {
                                  void s.pendingFileDelete.set(item.path);
                                }}
                                aria-label={'Delete ' + item.name}
                              >
                                <Icon name="trash-2" size={16} />
                              </button>
                            </>
                          )}
                        </div>
                      </Fragment>
                    );
                  })}
                </section>
              </>
            )}
          </>
        ) : s.status() === 'locked' ? (
          <>
            <form
              className="unlock"
              onSubmit={($event) => {
                $event.preventDefault();
                void s.unlock();
              }}
            >
              <Icon name="lock" size={20} />
              <p className="u-title">Vault is locked</p>
              <input
                className="field"
                type="password"
                placeholder="Master password"
                ref={(field) => field?.focus()}
                value={s.masterPassword()}
                onChange={($event) => {
                  s.masterPassword.set($event.currentTarget.value);
                }}
                name="masterPassword"
              />
              {s.error() ? (
                <>
                  <p className="error">{s.error()}</p>
                </>
              ) : null}
              <button className="primary" type="submit" disabled={s.busy()}>
                Unlock
              </button>
            </form>
          </>
        ) : s.status() === 'missing' ? (
          <>
            <form
              className="unlock"
              onSubmit={($event) => {
                $event.preventDefault();
                void s.create();
              }}
            >
              <Icon name="lock" size={20} />
              <p className="u-title">Create your vault</p>
              <p className="hint">
                Choose a master password. There is no way to recover it if it is lost.
              </p>
              <input
                className="field"
                type="password"
                placeholder="Master password (min. 8 characters)"
                ref={(field) => field?.focus()}
                value={s.masterPassword()}
                onChange={($event) => {
                  s.masterPassword.set($event.currentTarget.value);
                }}
                name="masterPassword"
              />
              <input
                className="field"
                type="password"
                placeholder="Confirm master password"
                value={s.confirmPassword()}
                onChange={($event) => {
                  s.confirmPassword.set($event.currentTarget.value);
                }}
                name="confirmPassword"
              />
              {s.error() ? (
                <>
                  <p className="error">{s.error()}</p>
                </>
              ) : null}
              <button className="primary" type="submit" disabled={s.busy()}>
                Create vault
              </button>
            </form>
          </>
        ) : null}
      </section>
    </div>
  );
}
