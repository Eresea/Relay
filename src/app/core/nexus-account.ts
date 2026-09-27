import { DestroyRef, Injectable, inject, signal } from '@angular/core';

import { TauriBridge, type NexusAuthStatus } from './tauri';

@Injectable({ providedIn: 'root' })
export class NexusAccount {
  private readonly tauri = inject(TauriBridge);
  private readonly destroyRef = inject(DestroyRef);
  readonly available = this.tauri.available;
  readonly status = signal<NexusAuthStatus>({
    connected: false,
    mfaRequired: false,
    userId: null,
    email: null,
    displayName: null,
  });
  readonly busy = signal(false);
  readonly error = signal('');
  readonly mfaRequired = signal(false);
  private googleTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const unlisten = await this.tauri.onNexusAuth((status) => {
        this.status.set(status);
        this.mfaRequired.set(Boolean(status.mfaRequired));
        this.clearGooglePending();
        this.busy.set(false);
        this.error.set(
          status.connected || status.mfaRequired
            ? ''
            : status.error || 'Nexus sign-in did not complete. Try again.',
        );
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

  async login(email: string, password: string): Promise<void> {
    if (this.busy() || !this.available) return;
    this.busy.set(true);
    this.error.set('');
    try {
      this.mfaRequired.set((await this.tauri.nexusAuthLogin(email, password)).mfaRequired);
    } catch (error) {
      this.error.set(
        this.errorStatus(error) === 401
          ? 'Email or password is incorrect, or the email has not been verified.'
          : this.errorMessage(error),
      );
    } finally {
      this.busy.set(false);
    }
  }

  async register(email: string, password: string, displayName: string): Promise<boolean> {
    if (this.busy() || !this.available) return false;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.tauri.nexusAuthRegister(email, password, displayName);
      return true;
    } catch (error) {
      this.error.set(
        this.errorStatus(error) === 409
          ? 'That email address is already registered.'
          : this.errorMessage(error),
      );
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  async verifyEmail(token: string): Promise<boolean> {
    if (this.busy() || !this.available) return false;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.tauri.nexusAuthVerifyEmail(token);
      return true;
    } catch (error) {
      this.error.set(
        this.errorStatus(error) === 401
          ? 'That verification token is invalid or expired.'
          : this.errorMessage(error),
      );
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  async verifyMfa(code: string, recoveryCode = ''): Promise<void> {
    if (this.busy() || !this.available) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.tauri.nexusAuthVerifyMfa(code, recoveryCode);
      this.mfaRequired.set(false);
    } catch {
      this.mfaRequired.set(false);
      this.error.set('Nexus could not verify this code. Sign in again and retry.');
    } finally {
      this.busy.set(false);
    }
  }

  async googleLogin(): Promise<void> {
    if (this.busy() || !this.available) return;
    this.busy.set(true);
    this.error.set('');
    this.googleTimeout = setTimeout(() => {
      this.clearGooglePending();
      this.busy.set(false);
      this.error.set('Google sign-in timed out. Try again.');
    }, 5 * 60 * 1000);
    try {
      await this.tauri.nexusAuthGoogleStart();
    } catch (error) {
      this.clearGooglePending();
      this.busy.set(false);
      this.showError(error);
    }
  }

  private clearGooglePending(): void {
    if (this.googleTimeout) clearTimeout(this.googleTimeout);
    this.googleTimeout = undefined;
  }

  async logout(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.tauri.nexusAuthLogout();
      this.status.set(await this.tauri.nexusAuthStatus());
    } catch (error) {
      this.showError(error);
    } finally {
      this.busy.set(false);
    }
  }

  private showError(error: unknown): void {
    this.error.set(this.errorMessage(error));
  }

  private errorMessage(error: unknown): string {
    return typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : 'Could not update your Nexus account.';
  }

  private errorStatus(error: unknown): number | null {
    const message = this.errorMessage(error);
    return Number(message.match(/request failed with (\d{3})/)?.[1]) || null;
  }
}
