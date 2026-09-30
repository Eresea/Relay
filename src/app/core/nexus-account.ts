import { DestroyRef, Injectable, inject, signal } from '@angular/core';

import { TauriBridge, type NexusAuthStatus } from './tauri';

/** The hosted sign-in attempt expires after this long; stop showing "waiting". */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class NexusAccount {
  private readonly tauri = inject(TauriBridge);
  private readonly destroyRef = inject(DestroyRef);
  readonly available = this.tauri.available;
  readonly status = signal<NexusAuthStatus>({
    connected: false,
    userId: null,
    email: null,
    displayName: null,
  });
  readonly busy = signal(false);
  /** The hosted page is open and Relay is waiting for the deep-link callback. */
  readonly waiting = signal(false);
  readonly error = signal('');
  private waitTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    void this.initialize();
    this.destroyRef.onDestroy(() => this.clearWait());
  }

  private async initialize(): Promise<void> {
    try {
      const unlisten = await this.tauri.onNexusAuth((status) => {
        this.status.set(status);
        this.clearWait();
        // A revoked or ended session just returns to signed out; only a failed sign-in explains itself.
        this.error.set(status.connected ? '' : (status.error ?? ''));
      });
      if (this.destroyRef.destroyed) {
        unlisten();
        return;
      }
      this.destroyRef.onDestroy(unlisten);
      this.status.set(await this.tauri.nexusAuthStatus());
    } catch (error) {
      this.showError(error);
    }
  }

  /** "Sign in with Nexus": opens the hosted page; the session arrives as an auth event. */
  async login(): Promise<void> {
    if (!this.available) return;
    this.error.set('');
    try {
      await this.tauri.nexusAuthStart();
      this.clearWait();
      this.waiting.set(true);
      this.waitTimeout = setTimeout(() => this.waiting.set(false), SIGN_IN_TIMEOUT_MS);
    } catch (error) {
      this.showError(error);
    }
  }

  async logout(everywhere = false): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.tauri.nexusAuthLogout(everywhere);
    } catch (error) {
      this.showError(error);
    } finally {
      this.status.set(await this.tauri.nexusAuthStatus());
      this.busy.set(false);
    }
  }

  private clearWait(): void {
    if (this.waitTimeout) clearTimeout(this.waitTimeout);
    this.waitTimeout = undefined;
    this.waiting.set(false);
  }

  private showError(error: unknown): void {
    this.error.set(
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : 'Could not update your Nexus account.',
    );
  }
}
