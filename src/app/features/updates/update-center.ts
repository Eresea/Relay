import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Injectable,
  signal,
} from '@angular/core';

import type { AppEvent, UpdateSnapshot } from '@core/events';
import { TauriBridge } from '@core/tauri';

const IDLE_UPDATE: UpdateSnapshot = {
  state: 'idle',
  currentVersion: 'dev',
  downloadedBytes: 0,
};

@Injectable({ providedIn: 'root' })
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

@Component({
  selector: 'rl-update-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="update-wrap" [attr.data-state]="snapshot().state">
      <button
        type="button"
        class="indicator"
        [attr.aria-label]="label()"
        [attr.title]="label()"
        (click)="activate()"
      >
        <span class="dot" aria-hidden="true"></span>
        @if (trackVisible()) {
          <span class="track" [class.indeterminate]="progress() === null">
            @if (progress() !== null) {
              <span class="fill" [style.inline-size.%]="progress()"></span>
            }
          </span>
        }
        <span class="u-sr-only">{{ label() }}</span>
      </button>

      @if (snapshot().state !== 'idle') {
        <div class="popover" role="status" aria-live="polite">
          <p class="eyebrow">Update</p>
          <p class="title">{{ title() }}</p>
          <p class="detail">{{ detail() }}</p>
          @if (actionLabel()) {
            <button type="button" class="action" (click)="activate()">
              {{ actionLabel() }}
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      flex: none;
    }

    .update-wrap {
      position: relative;
      display: flex;
      justify-content: flex-end;
      align-items: center;
    }

    .indicator {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      min-block-size: var(--control-sm);
      padding-inline: var(--space-4);
      color: var(--text-subtle);
      border-radius: var(--radius-sm);
    }

    .indicator:hover,
    .indicator:focus-visible {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .dot {
      inline-size: 6px;
      block-size: 6px;
      flex: none;
      border-radius: var(--radius-pill);
      background: var(--status-idle);
    }

    [data-state='checking'] .dot,
    [data-state='downloading'] .dot,
    [data-state='installing'] .dot {
      background: var(--status-running);
      animation: update-pulse 1.4s ease-in-out infinite;
    }

    [data-state='available'] .dot {
      background: var(--status-waiting);
    }

    [data-state='ready'] .dot {
      background: var(--status-done);
    }

    [data-state='error'] .dot {
      background: var(--status-blocked);
    }

    .track {
      position: relative;
      display: block;
      inline-size: 52px;
      block-size: 2px;
      overflow: hidden;
      border-radius: var(--radius-pill);
      background: var(--border-strong);
    }

    .fill {
      display: block;
      block-size: 100%;
      background: var(--status-running);
      transition: inline-size var(--dur-panel) var(--ease-standard);
    }

    .track.indeterminate::after {
      position: absolute;
      inset: 0 auto 0 -35%;
      inline-size: 35%;
      content: '';
      background: var(--status-running);
      animation: update-slide 1.2s ease-in-out infinite;
    }

    .popover {
      position: absolute;
      inset-block-end: calc(100% + var(--space-3));
      inset-inline-end: var(--space-3);
      z-index: 2;
      inline-size: 240px;
      padding: var(--space-5);
      color: var(--text-body);
      background: var(--bg-overlay);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-lg);
      opacity: 0;
      pointer-events: none;
      transform: translateY(var(--space-2));
      transition:
        opacity var(--dur-hover) var(--ease-standard),
        transform var(--dur-hover) var(--ease-standard);
    }

    .update-wrap:hover .popover,
    .update-wrap:focus-within .popover {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }

    .eyebrow {
      margin: 0;
      color: var(--text-subtle);
      font-size: var(--text-11);
      font-weight: var(--weight-semibold);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .title {
      margin: var(--space-2) 0 0;
      color: var(--text-strong);
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
    }

    .detail {
      margin: var(--space-2) 0 0;
      color: var(--text-muted);
      font-size: var(--text-12);
      line-height: 1.4;
    }

    .action {
      margin-block-start: var(--space-4);
      padding: var(--space-2) var(--space-3);
      color: var(--text-body);
      background: var(--tint-hover);
      border-radius: var(--radius-sm);
      font-size: var(--text-12);
    }

    .action:hover {
      background: var(--tint-selected);
    }

    @keyframes update-pulse {
      50% {
        opacity: 0.45;
      }
    }

    @keyframes update-slide {
      to {
        transform: translateX(385%);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .dot,
      .track.indeterminate::after {
        animation: none;
      }
    }
  `,
})
export class UpdateStatusBar {
  private readonly center = inject(UpdateCenter);

  protected readonly snapshot = this.center.snapshot;
  protected readonly progress = computed(() => {
    const { downloadedBytes, contentLength } = this.snapshot();
    if (!contentLength || contentLength <= 0) return null;
    return Math.min(100, Math.round((downloadedBytes / contentLength) * 100));
  });
  protected readonly trackVisible = computed(() => {
    const state = this.snapshot().state;
    return state === 'downloading' || state === 'installing';
  });
  protected readonly label = computed(() => {
    switch (this.snapshot().state) {
      case 'checking':
        return 'Checking for updates';
      case 'available':
        return 'Update available';
      case 'downloading':
        return 'Downloading update';
      case 'ready':
        return 'Update ready to install';
      case 'installing':
        return 'Applying update';
      case 'error':
        return 'Update check failed';
      case 'idle':
        return 'Relay is up to date';
    }
  });
  protected readonly title = computed(() => {
    const snapshot = this.snapshot();
    if (snapshot.state === 'ready') return `Relay ${snapshot.version ?? 'update'} is ready`;
    if (snapshot.state === 'available') return `Relay ${snapshot.version ?? 'update'} available`;
    return this.label();
  });
  protected readonly detail = computed(() => {
    const snapshot = this.snapshot();
    if (snapshot.state === 'error') return snapshot.error ?? 'Try checking again.';
    if (snapshot.state === 'installing') return 'Relay will restart when installation is complete.';
    if (snapshot.notes) return snapshot.notes;
    if (snapshot.state === 'ready') return 'Restart Relay to apply the downloaded update.';
    return `Current version ${snapshot.currentVersion}`;
  });
  protected readonly actionLabel = computed(() => {
    switch (this.snapshot().state) {
      case 'available':
        return 'Download update';
      case 'ready':
        return 'Restart to update';
      case 'error':
        return 'Retry update';
      case 'idle':
        return 'Check for updates';
      default:
        return '';
    }
  });

  protected activate(): void {
    switch (this.snapshot().state) {
      case 'idle':
      case 'error':
        void this.center.check();
        break;
      case 'available':
        void this.center.download();
        break;
      case 'ready':
        void this.center.install();
        break;
    }
  }
}
