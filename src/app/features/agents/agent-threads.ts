import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { TauriBridge, type CodexThread, type CodexThreadDetails } from '@core/tauri';
import { Icon } from '@shared/icon';

@Component({
  selector: 'rl-agent-threads',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <section class="agents" aria-labelledby="agents-title">
      <header class="page-header">
        <div>
          <p class="u-caption">Codex</p>
          <h1 id="agents-title">Agent threads</h1>
        </div>
        @if (!opened()) {
          <button
            type="button"
            class="action"
            [disabled]="loading() || openingId() !== null"
            (click)="refresh()"
          >
            <rl-icon [name]="loading() ? 'loader-circle' : 'refresh-cw'" [size]="14" />
            Refresh
          </button>
        }
      </header>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      } @else if (loading()) {
        <p class="state" aria-live="polite">Loading threads…</p>
      } @else if (opened(); as details) {
        <div class="thread-toolbar">
          <button type="button" class="action" (click)="opened.set(null)">
            <rl-icon name="arrow-left" [size]="14" />
            All threads
          </button>
          <span class="thread-path">{{ details.thread.cwd }}</span>
        </div>
        <div class="messages" aria-label="Thread messages">
          @if (details.olderCursor) {
            <button
              type="button"
              class="action load-older"
              [disabled]="loadingEarlier()"
              (click)="loadEarlier(details)"
            >
              {{ loadingEarlier() ? 'Loading…' : 'Load earlier messages' }}
            </button>
          }
          @if (paginationError()) {
            <p class="error" role="alert">{{ paginationError() }}</p>
          }
          @for (message of details.messages; track $index) {
            <article class="message" [class.user-message]="message.role === 'You'">
              <span class="message-role">{{ message.role }}</span>
              <p>{{ message.text }}</p>
            </article>
          } @empty {
            <p class="state">This thread has no visible messages.</p>
          }
        </div>
      } @else if (threads().length === 0) {
        <div class="empty">
          <rl-icon name="bot" [size]="20" />
          <p>No Codex threads found</p>
        </div>
      } @else {
        <div class="thread-list" role="list" aria-label="Codex threads">
          @for (thread of threads(); track thread.id) {
            <button
              type="button"
              class="thread-row"
              role="listitem"
              [disabled]="openingId() !== null"
              (click)="open(thread)"
            >
              <rl-icon
                [name]="openingId() === thread.id ? 'loader-circle' : 'message-square'"
                [size]="16"
              />
              <span>{{ thread.title }}</span>
              <rl-icon name="chevron-right" [size]="14" />
            </button>
          }
        </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-block-size: 100%;
    }

    .agents {
      display: flex;
      max-inline-size: 860px;
      min-block-size: 100%;
      flex-direction: column;
      margin-inline: auto;
      padding: var(--space-9) var(--space-8);
    }

    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-6);
      padding-block-end: var(--space-6);
      border-block-end: 1px solid var(--border-subtle);
    }

    .page-header h1,
    .page-header p,
    .error,
    .state,
    .empty p,
    .message p {
      margin: 0;
    }

    .page-header h1 {
      margin-block-start: var(--space-1);
      font-size: var(--text-20);
      letter-spacing: -0.04em;
    }

    .action {
      display: inline-flex;
      align-items: center;
      min-block-size: 36px;
      gap: var(--space-2);
      padding-inline: var(--space-3);
      color: var(--text-body);
      background: var(--bg-raised);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      font-size: var(--text-12);
    }

    .action:disabled,
    .thread-row:disabled {
      opacity: 0.55;
      cursor: wait;
    }

    .thread-list {
      padding-block-start: var(--space-4);
    }

    .thread-row {
      display: flex;
      align-items: center;
      inline-size: 100%;
      min-block-size: 48px;
      gap: var(--space-3);
      padding-inline: var(--space-3);
      color: var(--text-body);
      border-block-end: 1px solid var(--border-subtle);
      text-align: start;
    }

    .thread-row span {
      flex: 1;
      min-inline-size: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .thread-row:hover,
    .thread-row:focus-visible,
    .action:hover,
    .action:focus-visible {
      background: var(--tint-hover);
    }

    .empty,
    .state {
      display: flex;
      align-items: center;
      justify-content: center;
      min-block-size: 120px;
      gap: var(--space-3);
      color: var(--text-muted);
      font-size: var(--text-13);
    }

    .error {
      margin-block-start: var(--space-5);
      color: var(--danger-ink);
      font-size: var(--text-13);
    }

    .thread-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      padding-block: var(--space-4);
      border-block-end: 1px solid var(--border-subtle);
    }

    .thread-path {
      overflow: hidden;
      color: var(--text-muted);
      font-size: var(--text-12);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .messages {
      flex: 1;
      overflow: auto;
      padding-block: var(--space-4);
    }

    .load-older {
      margin: 0 auto var(--space-5);
    }

    .message {
      max-inline-size: 760px;
      margin-block-end: var(--space-5);
      padding: var(--space-4);
      color: var(--text-body);
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .user-message {
      margin-inline-start: auto;
      background: var(--bg-raised);
    }

    .message-role {
      display: block;
      margin-block-end: var(--space-2);
      color: var(--text-muted);
      font-size: var(--text-11);
    }

    .message p {
      font-size: var(--text-13);
      line-height: 1.55;
    }

    @media (max-width: 720px) {
      .agents {
        padding: var(--space-6) var(--space-4);
      }
    }
  `,
})
export class AgentThreads {
  private readonly tauri = inject(TauriBridge);

  protected readonly threads = signal<readonly CodexThread[]>([]);
  protected readonly loading = signal(true);
  protected readonly openingId = signal<string | null>(null);
  protected readonly loadingEarlier = signal(false);
  protected readonly opened = signal<CodexThreadDetails | null>(null);
  protected readonly error = signal('');
  protected readonly paginationError = signal('');

  constructor() {
    void this.refresh();
  }

  protected async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.opened.set(null);
    try {
      this.threads.set(await this.tauri.codexThreads());
      if (!this.tauri.available)
        this.error.set('Agent threads are available in the Relay desktop app.');
    } catch {
      this.error.set(
        'Could not connect to Codex. Check that the Codex CLI is installed and signed in.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  protected async open(thread: CodexThread): Promise<void> {
    if (this.openingId()) return;
    this.openingId.set(thread.id);
    this.error.set('');
    try {
      const details = await this.tauri.codexOpenThread(thread.id);
      if (details) {
        this.opened.set(details);
        this.paginationError.set('');
      }
    } catch {
      this.error.set('Could not open that thread. Refresh and try again.');
    } finally {
      this.openingId.set(null);
    }
  }

  protected async loadEarlier(details: CodexThreadDetails): Promise<void> {
    if (!details.olderCursor || this.loadingEarlier()) return;
    this.loadingEarlier.set(true);
    this.paginationError.set('');
    try {
      const page = await this.tauri.codexOlderMessages(details.thread.id, details.olderCursor);
      if (!page) return;
      this.opened.update((current) =>
        current?.thread.id === details.thread.id
          ? {
              ...current,
              messages: [...page.messages, ...current.messages],
              olderCursor: page.nextCursor,
            }
          : current,
      );
    } catch {
      this.paginationError.set('Could not load earlier messages. Try again.');
    } finally {
      this.loadingEarlier.set(false);
    }
  }
}
