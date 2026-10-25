import type { AppEvent, UpdateSnapshot } from '@/core/events';
import { TauriBridge } from '@/core/tauri';
import { inject } from '@/lib/inject';
import { signal } from '@/lib/signals';

const IDLE_UPDATE: UpdateSnapshot = {
  state: 'idle',
  currentVersion: 'dev',
  downloadedBytes: 0,
};

export class UpdateCenter {
  private readonly tauri = inject(TauriBridge);

  readonly snapshot = signal<UpdateSnapshot>(IDLE_UPDATE);

  restore(snapshot: UpdateSnapshot): void {
    this.snapshot.set(snapshot);
  }

  handle(event: AppEvent): void {
    if (event.type === 'updateChanged') this.snapshot.set(event);
  }

  async check(): Promise<void> {
    await this.tauri.updateCheck();
  }

  async download(): Promise<void> {
    await this.tauri.updateDownload();
  }

  async install(): Promise<void> {
    await this.tauri.updateInstall();
  }
}
