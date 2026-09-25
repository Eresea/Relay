import { ChangeDetectionStrategy, Component, SecurityContext, inject, signal } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { marked } from 'marked';

import {
  TauriBridge,
  type CodexThread,
  type CodexThreadItem,
  type CodexThreadSummary,
  type WorkspaceSummary,
} from '@core/tauri';
import { Icon } from '@shared/icon';

const THREAD_SETTING = 'codex.lastThreadId';

@Component({
  selector: 'rl-codex',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <section class="codex" aria-labelledby="codex-title">
      <header class="page-header">
        <div>
          <p class="u-caption">Local Codex</p>
          @if (screen() === 'history') {
            <h1 id="codex-title">Threads</h1>
          } @else if (screen() === 'compose') {
            <h1 id="codex-title">Send work to Codex</h1>
          } @else {
            <h1 id="codex-title">{{ threadTitle() }}</h1>
          }
        </div>
        @if (screen() === 'history') {
          <button type="button" class="primary" (click)="newThread()">
            <rl-icon name="plus" [size]="14" />
            New thread
          </button>
        } @else if (screen() === 'compose') {
          <button type="button" class="action" (click)="showHistory()">Threads</button>
        } @else {
          <div class="thread-actions">
            <button type="button" class="action" (click)="showHistory()">All threads</button>
            <button type="button" class="action" (click)="openInCodex()">Open in Codex</button>
            <button type="button" class="primary" (click)="continueThread()">
              <rl-icon name="reply" [size]="14" />
              Continue
            </button>
          </div>
        }
      </header>

      @if (screen() === 'history') {
        <div class="thread-list" aria-label="Local Codex threads">
          @if (threadListError()) {
            <p class="error" role="alert">{{ threadListError() }}</p>
          }
          @if (loadingThreads() && threads().length === 0) {
            <p class="state" role="status">Loading Codex threads…</p>
          } @else if (threads().length === 0) {
            <p class="state" role="status">No local Codex threads yet.</p>
          } @else {
            @for (thread of threads(); track thread.id) {
              <button
                type="button"
                class="thread-row"
                [disabled]="loadingThread()"
                (click)="openThread(thread.id)"
              >
                <span class="thread-row-main">
                  <span class="thread-row-title">{{ summaryTitle(thread) }}</span>
                  <span class="thread-row-preview">{{ thread.preview || thread.cwd }}</span>
                </span>
                <span class="thread-row-meta">
                  <span>{{ thread.model || 'Codex' }}</span>
                  <time [attr.datetime]="threadDate(thread).toISOString()">
                    {{ threadDate(thread).toLocaleString() }}
                  </time>
                </span>
              </button>
            }
          }
          @if (nextCursor()) {
            <button
              type="button"
              class="action load-more"
              [disabled]="loadingThreads()"
              (click)="loadMoreThreads()"
            >
              {{ loadingThreads() ? 'Loading…' : 'Load older threads' }}
            </button>
          }
        </div>
      }

      @if (screen() === 'compose') {
        <div class="form">
          <label>
            Workspace
            <select
              [value]="workingDirectory()"
              (change)="workingDirectory.set($any($event.target).value)"
              [disabled]="sending() || loadingWorkspaces() || workspaces().length === 0"
            >
              @for (workspace of workspaces(); track workspace.path) {
                <option [value]="workspace.path">
                  {{ workspace.name }} — {{ workspace.path }}
                </option>
              }
            </select>
          </label>
          @if (workspaces().length === 0 && !loadingWorkspaces()) {
            <p class="state" role="status">Relay has not discovered a local Git workspace yet.</p>
          }

          <label>
            Resume thread ID
            <input
              type="text"
              [value]="threadId()"
              (input)="threadId.set($any($event.target).value)"
              [disabled]="sending()"
              placeholder="Leave blank to start a new thread"
              autocomplete="off"
            />
          </label>

          <label>
            Prompt
            <textarea
              rows="6"
              maxlength="64000"
              placeholder="Describe the work for Codex…"
              [disabled]="sending()"
              [value]="promptText()"
              (input)="promptText.set($any($event.target).value)"
              (keydown.control.enter)="send(promptText())"
            ></textarea>
          </label>
          <p class="permission-note">
            Codex can edit this workspace and run commands without further approval. Reads include
            platform defaults. Network is disabled; requests for extra access are declined.
          </p>

          @if (error()) {
            <p class="error" role="alert">{{ error() }}</p>
          }
          <button
            type="button"
            class="primary"
            [disabled]="sending() || !workingDirectory() || !promptText().trim()"
            (click)="send(promptText())"
          >
            <rl-icon [name]="sending() ? 'loader-circle' : 'command'" [size]="14" />
            {{ sending() ? 'Waiting for Codex…' : 'Send to Codex' }}
          </button>

          @if (response()) {
            <section class="response" aria-live="polite">
              <div class="response-heading">
                <h2>Codex response</h2>
                <button type="button" class="action" (click)="openInCodex()">Open in Codex</button>
              </div>
              <pre>{{ response() }}</pre>
            </section>
          }
        </div>
      }

      @if (screen() === 'thread') {
        @if (loadingThread()) {
          <p class="state" role="status">Loading thread…</p>
        } @else if (threadError()) {
          <p class="error" role="alert">{{ threadError() }}</p>
        } @else if (activeThread(); as thread) {
          <div class="thread-detail">
            <p class="thread-location">{{ thread.cwd }}</p>
            @if (thread.turns.length === 0) {
              <p class="state">This thread has no messages.</p>
            }
            @for (turn of thread.turns; track turn.id) {
              <section class="turn" [attr.aria-label]="'Turn ' + turn.status">
                @for (item of turn.items; track item.id ?? $index) {
                  @if (item.type === 'userMessage') {
                    <article class="message user-message">
                      <h2>You</h2>
                      @for (content of userContent(item); track $index) {
                        @if (content['type'] === 'text') {
                          <div
                            class="markdown"
                            [innerHTML]="renderMarkdown(asString(content['text']))"
                          ></div>
                        } @else {
                          <p class="attachment">{{ contentLabel(content) }}</p>
                        }
                      }
                    </article>
                  } @else if (item.type === 'agentMessage' || item.type === 'plan') {
                    <article class="message agent-message">
                      <h2>{{ item.type === 'plan' ? 'Plan' : 'Codex' }}</h2>
                      <div
                        class="markdown"
                        [innerHTML]="renderMarkdown(asString(item['text']))"
                      ></div>
                    </article>
                  } @else {
                    <details class="thread-item">
                      <summary>{{ itemTitle(item) }}</summary>
                      <pre>{{ itemDetails(item) }}</pre>
                    </details>
                  }
                }
              </section>
            }
          </div>
        }
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      block-size: 100%;
      overflow: auto;
    }

    .codex {
      max-inline-size: 860px;
      margin-inline: auto;
      padding: var(--space-9) var(--space-8);
    }

    .page-header,
    .response-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
    }

    .page-header {
      padding-block-end: var(--space-6);
      border-block-end: 1px solid var(--border-subtle);
    }

    .thread-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: end;
      gap: var(--space-2);
    }

    .thread-list {
      display: grid;
      gap: var(--space-2);
      padding-block-start: var(--space-5);
    }

    .thread-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      inline-size: 100%;
      padding: var(--space-4);
      color: var(--text-body);
      text-align: start;
      background: var(--bg-raised);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      cursor: pointer;
    }

    .thread-row:hover,
    .thread-row:focus-visible {
      border-color: var(--border-focus);
      outline: none;
    }

    .thread-row-main,
    .thread-row-meta {
      display: grid;
      min-inline-size: 0;
      gap: var(--space-1);
    }

    .thread-row-title {
      overflow: hidden;
      color: var(--text-strong);
      font-size: var(--text-14);
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .thread-row-preview,
    .thread-row-meta,
    .thread-location {
      color: var(--text-muted);
      font-size: var(--text-12);
    }

    .thread-row-preview {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .thread-row-meta {
      flex: none;
      justify-items: end;
    }

    .load-more {
      justify-self: center;
    }

    .thread-detail {
      display: grid;
      max-inline-size: 920px;
      gap: var(--space-4);
      margin-inline: auto;
      padding-block: var(--space-5);
    }

    .thread-location {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .turn {
      display: grid;
      justify-items: stretch;
      gap: var(--space-3);
    }

    .message {
      max-inline-size: 92%;
      padding: var(--space-4);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      overflow-wrap: anywhere;
    }

    .message h2 {
      margin: 0 0 var(--space-2);
      color: var(--text-muted);
      font-size: var(--text-12);
      font-weight: 600;
    }

    .user-message {
      justify-self: end;
      background: var(--bg-raised);
    }

    .agent-message {
      justify-self: start;
      background: var(--bg-sunken);
    }

    .attachment {
      margin: 0;
      padding: var(--space-2) var(--space-3);
      color: var(--text-muted);
      background: var(--bg-app);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      font-size: var(--text-12);
      overflow-wrap: anywhere;
    }

    .thread-item {
      justify-self: stretch;
      color: var(--text-muted);
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      font-size: var(--text-12);
    }

    .thread-item summary {
      padding: var(--space-3) var(--space-4);
      color: var(--text-body);
      cursor: pointer;
    }

    .thread-item pre {
      max-block-size: 420px;
      margin: 0;
      padding: var(--space-4);
      overflow: auto;
      border-block-start: 1px solid var(--border-subtle);
      font: inherit;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    :host ::ng-deep .markdown {
      color: var(--text-body);
      font-size: var(--text-13);
      line-height: 1.6;
    }

    :host ::ng-deep .markdown :is(p, ul, ol, blockquote, pre, table) {
      margin: 0 0 var(--space-3);
    }

    :host ::ng-deep .markdown :is(p, ul, ol, blockquote, pre, table):last-child {
      margin-block-end: 0;
    }

    :host ::ng-deep .markdown :is(h1, h2, h3, h4) {
      margin: var(--space-4) 0 var(--space-2);
      color: var(--text-strong);
      font-size: var(--text-14);
      font-weight: 600;
    }

    :host ::ng-deep .markdown :is(ul, ol) {
      padding-inline-start: var(--space-5);
    }

    :host ::ng-deep .markdown pre {
      padding: var(--space-3);
      overflow: auto;
      background: var(--bg-app);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
    }

    :host ::ng-deep .markdown code {
      font-family: var(--font-mono);
    }

    :host ::ng-deep .markdown a {
      color: var(--text-strong);
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    :host ::ng-deep .markdown blockquote {
      padding-inline-start: var(--space-3);
      border-inline-start: 2px solid var(--border-strong);
    }

    @media (max-width: 680px) {
      .codex {
        padding-inline: var(--space-4);
      }

      .thread-row {
        align-items: start;
      }

      .thread-row-meta {
        max-inline-size: 40%;
        text-align: end;
      }

      .message {
        max-inline-size: 100%;
      }
    }

    .page-header h1,
    .page-header p,
    .response h2 {
      margin: 0;
    }

    .page-header h1 {
      margin-block-start: var(--space-1);
      font-size: var(--text-20);
      letter-spacing: -0.04em;
    }

    .form {
      display: grid;
      gap: var(--space-5);
      padding-block-start: var(--space-6);
    }

    label {
      display: grid;
      gap: var(--space-2);
      color: var(--text-muted);
      font-size: var(--text-12);
    }

    input,
    select,
    textarea {
      inline-size: 100%;
      min-block-size: 40px;
      padding: var(--space-3);
      color: var(--text-body);
      background: var(--bg-raised);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      font: inherit;
    }

    input:focus-visible,
    select:focus-visible,
    textarea:focus-visible {
      background: var(--bg-app);
      border-color: var(--border-focus);
      box-shadow: var(--focus-ring);
      outline: none;
    }

    textarea {
      min-block-size: 140px;
      resize: vertical;
    }

    .permission-note,
    .error,
    .state {
      margin: 0;
      font-size: var(--text-12);
    }

    .permission-note {
      color: var(--text-muted);
    }

    .error {
      color: var(--danger-ink);
    }

    .state {
      color: var(--text-muted);
    }

    .action,
    .primary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      justify-self: start;
      min-block-size: 36px;
      gap: var(--space-2);
      padding-inline: var(--space-3);
      color: var(--text-body);
      background: var(--bg-raised);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      font-size: var(--text-12);
    }

    .primary {
      color: var(--text-strong);
      border-color: var(--border-strong);
    }

    button:disabled {
      opacity: 0.55;
      cursor: wait;
    }

    .response {
      display: grid;
      gap: var(--space-3);
      padding-block-start: var(--space-5);
      border-block-start: 1px solid var(--border-subtle);
    }

    .response h2 {
      font-size: var(--text-14);
    }

    .response pre {
      margin: 0;
      padding: var(--space-4);
      color: var(--text-body);
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      font: inherit;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
})
export class Codex {
  private readonly tauri = inject(TauriBridge);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly markdownCache = new Map<string, string>();

  protected readonly screen = signal<'history' | 'compose' | 'thread'>('history');
  protected readonly workspaces = signal<readonly WorkspaceSummary[]>([]);
  protected readonly workingDirectory = signal('');
  protected readonly threadId = signal('');
  protected readonly threads = signal<readonly CodexThreadSummary[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly activeThread = signal<CodexThread | null>(null);
  protected readonly promptText = signal('');
  protected readonly response = signal('');
  protected readonly error = signal('');
  protected readonly threadError = signal('');
  protected readonly threadListError = signal('');
  protected readonly sending = signal(false);
  protected readonly loadingWorkspaces = signal(true);
  protected readonly loadingThreads = signal(false);
  protected readonly loadingThread = signal(false);

  constructor() {
    void this.loadWorkspaces();
    void this.loadThreads(true);
  }

  protected async send(prompt: string): Promise<void> {
    if (this.sending() || !prompt.trim() || !this.workingDirectory()) return;
    this.sending.set(true);
    this.error.set('');
    this.response.set('');
    try {
      const result = await this.tauri.codexSend(
        prompt,
        this.workingDirectory(),
        this.threadId().trim() || null,
      );
      this.threadId.set(result.threadId);
      this.promptText.set('');
      this.response.set(result.response);
      try {
        await this.tauri.setSetting(THREAD_SETTING, result.threadId);
      } catch {
        // Sending succeeded; the resume shortcut is only a convenience.
      }
      await this.openThread(result.threadId);
      void this.loadThreads(true);
    } catch (cause: unknown) {
      this.error.set(
        cause instanceof Error
          ? cause.message
          : typeof cause === 'string'
            ? cause
            : 'Could not reach Codex.',
      );
    } finally {
      this.sending.set(false);
    }
  }

  protected newThread(): void {
    this.threadId.set('');
    this.response.set('');
    this.error.set('');
    this.screen.set('compose');
    void this.tauri.setSetting(THREAD_SETTING, '');
  }

  protected showHistory(): void {
    this.screen.set('history');
    void this.loadThreads(true);
  }

  protected continueThread(): void {
    const thread = this.activeThread();
    if (!thread) return;
    this.threadId.set(thread.id);
    this.workingDirectory.set(thread.cwd);
    this.response.set('');
    this.error.set('');
    this.screen.set('compose');
  }

  protected async openThread(threadId: string): Promise<void> {
    this.threadId.set(threadId);
    this.screen.set('thread');
    this.loadingThread.set(true);
    this.threadError.set('');
    this.activeThread.set(null);
    try {
      const thread = await this.tauri.codexReadThread(threadId);
      this.activeThread.set(thread);
      try {
        await this.tauri.setSetting(THREAD_SETTING, threadId);
      } catch {
        // The transcript should remain available if persisting the resume shortcut fails.
      }
    } catch (cause: unknown) {
      this.threadError.set(errorMessage(cause, 'Could not load this Codex thread.'));
    } finally {
      this.loadingThread.set(false);
    }
  }

  protected async loadMoreThreads(): Promise<void> {
    await this.loadThreads(false);
  }

  protected summaryTitle(thread: CodexThreadSummary): string {
    return thread.name?.trim() || thread.preview.trim() || 'Untitled Codex thread';
  }

  protected threadTitle(): string {
    const thread = this.activeThread();
    return thread?.name?.trim() || thread?.preview.trim() || 'Codex thread';
  }

  protected threadDate(thread: CodexThreadSummary): Date {
    return new Date((thread.recencyAt ?? thread.updatedAt ?? thread.createdAt) * 1000);
  }

  protected userContent(item: CodexThreadItem): readonly Record<string, unknown>[] {
    const content = item['content'];
    return Array.isArray(content)
      ? content.filter(
          (value): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null && !Array.isArray(value),
        )
      : [];
  }

  protected contentLabel(content: Record<string, unknown>): string {
    const type = this.asString(content['type']);
    const detail = this.asString(content['path'] ?? content['url'] ?? content['name']);
    return `${type || 'Attachment'}${detail ? ` · ${detail}` : ''}`;
  }

  protected itemTitle(item: CodexThreadItem): string {
    const titles: Record<string, string> = {
      commandExecution: 'Command',
      fileChange: 'File changes',
      mcpToolCall: 'MCP tool call',
      dynamicToolCall: 'Tool call',
      webSearch: 'Web search',
      reasoning: 'Reasoning summary',
      imageView: 'Image attachment',
      imageGeneration: 'Image generation',
      collabAgentToolCall: 'Agent handoff',
      subAgentActivity: 'Subagent activity',
      contextCompaction: 'Context compaction',
      enteredReviewMode: 'Review started',
      exitedReviewMode: 'Review finished',
      functionCallOutput: 'Function output',
      hookPrompt: 'Hook prompt',
      sleep: 'Wait',
    };
    return titles[item.type] || item.type;
  }

  protected itemDetails(item: CodexThreadItem): string {
    return JSON.stringify(item, null, 2) ?? '';
  }

  protected asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  protected renderMarkdown(text: string): string {
    const cached = this.markdownCache.get(text);
    if (cached !== undefined) return cached;
    const rendered = marked.parse(text, { async: false });
    const safe = this.sanitizer.sanitize(SecurityContext.HTML, rendered) ?? '';
    this.markdownCache.set(text, safe);
    return safe;
  }

  protected openInCodex(): void {
    const id = this.threadId().trim();
    if (id) void this.tauri.openUrl(`codex://threads/${encodeURIComponent(id)}`);
  }

  private async loadWorkspaces(): Promise<void> {
    try {
      const [workspaces, lastThreadId] = await Promise.all([
        this.tauri.scanWorkspaces(),
        this.tauri.getSetting<string>(THREAD_SETTING, ''),
      ]);
      this.workspaces.set(workspaces);
      this.workingDirectory.set(workspaces[0]?.path ?? '');
      this.threadId.set(lastThreadId);
    } catch {
      this.error.set('Could not load local workspaces. Is Relay running on the desktop?');
    } finally {
      this.loadingWorkspaces.set(false);
    }
  }

  private async loadThreads(reset: boolean): Promise<void> {
    if (this.loadingThreads() || (!reset && !this.nextCursor())) return;
    const cursor = reset ? null : this.nextCursor();
    if (reset) {
      this.threads.set([]);
      this.nextCursor.set(null);
    }
    this.loadingThreads.set(true);
    this.threadListError.set('');
    try {
      const page = await this.tauri.codexListThreads(cursor);
      this.threads.set(reset ? page.threads : [...this.threads(), ...page.threads]);
      this.nextCursor.set(page.nextCursor);
    } catch (cause: unknown) {
      this.threadListError.set(errorMessage(cause, 'Could not load local Codex threads.'));
    } finally {
      this.loadingThreads.set(false);
    }
  }
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : fallback;
}
