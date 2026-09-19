import { Injectable } from '@angular/core';

/**
 * The boundary between the Angular app and the Rust core.
 *
 * Every `invoke` the app makes goes through here, so that (a) running in a
 * plain browser during `ng serve` degrades to a no-op instead of throwing, and
 * (b) there is one place to look for the full command surface.
 */
@Injectable({ providedIn: 'root' })
export class TauriBridge {
  readonly available = '__TAURI_INTERNALS__' in window;

  /** Hides the palette window without destroying it — reopening must be instant. */
  async dismissPalette(): Promise<void> {
    await this.invoke('dismiss_palette');
  }

  /** Runs a command that the Rust side owns (system actions, process control). */
  async runCoreCommand(id: string, args: Record<string, unknown> = {}): Promise<void> {
    await this.invoke('run_core_command', { id, args });
  }

  /** Commands contributed by the Rust side, merged into the registry at startup. */
  async coreCommands(): Promise<readonly CoreCommand[]> {
    return (await this.invoke<CoreCommand[]>('core_commands')) ?? [];
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

export interface CoreCommand {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  readonly hint?: string;
  readonly icon?: string;
}
