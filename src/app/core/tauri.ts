import { Injectable } from '@angular/core';

import type { AppEvent } from './events';

/**
 * The boundary between the Angular app and the Rust core.
 *
 * Every `invoke` and every event subscription the app makes goes through
 * here, so that (a) running in a plain browser during `ng serve` degrades to
 * a no-op instead of throwing, and (b) there is one place to look for the
 * full command surface.
 */
@Injectable({ providedIn: 'root' })
export class TauriBridge {
  readonly available = '__TAURI_INTERNALS__' in window;

  /** Hides the palette window without destroying it — reopening must be instant. */
  async dismissPalette(): Promise<void> {
    await this.invoke('dismiss_palette');
  }

  /**
   * Runs a command the Rust side owns. `command` mirrors
   * src-tauri/src/commands.rs's `CoreCommand` exactly — an id, and args for
   * whichever variants carry them — verified there by a test that every
   * `core_commands()` id actually deserializes into a real variant, so a
   * mismatch here fails in CI rather than silently doing nothing.
   */
  async runCoreCommand(command: CoreCommand): Promise<void> {
    await this.invoke('run_core_command', { command });
  }

  /** Requests cooperative cancellation; the job notices at its next checkpoint. */
  async cancelJob(jobId: string): Promise<void> {
    await this.invoke('cancel_job', { jobId });
  }

  /** A pull-based check alongside the push-based `notificationDone` event. */
  async isJobRunning(jobId: string): Promise<boolean> {
    return (await this.invoke<boolean>('is_job_running', { jobId })) ?? false;
  }

  /** Commands contributed by the Rust side, merged into the registry at startup. */
  async coreCommands(): Promise<readonly CoreCommandMeta[]> {
    return (await this.invoke<CoreCommandMeta[]>('core_commands')) ?? [];
  }

  /**
   * Subscribes to the core's single event channel. Returns the unlisten
   * function; callers dispose it on teardown. A no-op outside Tauri, so
   * ng serve keeps working without a live core — `handler` is simply never
   * called.
   */
  async onEvent(handler: (event: AppEvent) => void): Promise<() => void> {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op: nothing to unsubscribe from when there is no live Tauri event system
    if (!this.available) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen<AppEvent>('relay://event', (message) => handler(message.payload));
  }

  private async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T | null> {
    if (!this.available) {
      console.info(`[relay] invoke(${command}) skipped — not running under Tauri`, args);
      return null;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
  }
}

/** Mirrors src-tauri/src/commands.rs's `CoreCommand`. */
export type CoreCommand =
  | { readonly id: 'open_settings' }
  | { readonly id: 'open_main' }
  | { readonly id: 'hide_hud' }
  | { readonly id: 'quit' }
  | { readonly id: 'scan_home' };

/** What the palette displays for a core-contributed row. Mirrors `CoreCommandMeta`. */
export interface CoreCommandMeta {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  readonly hint?: string;
  readonly icon?: string;
}
