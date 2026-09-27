import {
  ChangeDetectionStrategy,
  Component,
  SecurityContext,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { marked } from 'marked';

import {
  TauriBridge,
  codexThreadPreview,
  codexThreadTitle,
  type CodexThread,
  type CodexThreadItem,
  type CodexThreadSummary,
  type GithubPullRequestSummary,
  type WorkspaceSummary,
} from '@core/tauri';
import { UmbraButtonComponent } from '@umbra/components/umbra-button/umbra-button.component';
import { UmbraInputComponent } from '@umbra/components/umbra-input/umbra-input.component';
import { UmbraTextareaComponent } from '@umbra/components/umbra-textarea/umbra-textarea.component';
import { Icon } from '@shared/icon';

@Component({
  selector: 'rl-codex',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, UmbraButtonComponent, UmbraInputComponent, UmbraTextareaComponent],
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
          <div class="thread-actions">
            <umbra-button
              size="sm"
              variant="outline"
              [disabled]="loadingThreads()"
              (click)="showHistory()"
            >
              Refresh
            </umbra-button>
            <umbra-button size="sm" [disabled]="sending()" (click)="newThread()">
              <rl-icon umbraButtonIcon name="plus" [size]="14" />
              New thread
            </umbra-button>
          </div>
        } @else if (screen() === 'compose') {
          <umbra-button size="sm" variant="outline" (click)="showHistory()">Threads</umbra-button>
        } @else {
          <div class="thread-actions">
            <umbra-button size="sm" variant="outline" (click)="showHistory()"
              >All threads</umbra-button
            >
            <umbra-button
              size="sm"
              variant="outline"
              [disabled]="loadingThread() || !activeThread()"
              (click)="openInCodex()"
            >
              Open in Codex
            </umbra-button>
            <umbra-button
              size="sm"
              [disabled]="loadingThread() || !activeThread()"
              (click)="continueThread()"
            >
              <rl-icon umbraButtonIcon name="chevron-right" [size]="14" />
              Continue
            </umbra-button>
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
          } @else if (threads().length === 0 && !threadListError()) {
            <p class="state" role="status">No local Codex threads yet.</p>
          } @else {
            @for (group of threadGroups(); track group.key) {
              <h2 class="thread-group-heading u-caption">
                <span>{{ group.label }}</span>
                <span class="u-mono">{{ group.threads.length }}</span>
              </h2>
              @for (thread of group.visibleThreads; track thread.id) {
                <div class="thread-row">
                  <button
                    type="button"
                    class="thread-open"
                    [disabled]="loadingThread()"
                    (click)="openThread(thread.id)"
                  >
                    <span class="thread-row-main">
                      <span class="thread-row-heading">
                        <span
                          class="thread-state"
                          role="img"
                          [attr.data-status]="threadStatus(thread)"
                          [attr.aria-label]="'Thread status: ' + threadStatus(thread)"
                          [attr.title]="threadStatus(thread)"
                        ></span>
                        <span class="thread-row-title">{{ summaryTitle(thread) }}</span>
                      </span>
                      <span class="thread-row-description">
                        @if (summaryPreview(thread) !== threadLocation(thread)) {
                          <span class="thread-row-preview">{{ summaryPreview(thread) }}</span>
                          <span class="thread-row-separator" aria-hidden="true">·</span>
                        }
                        <span class="thread-row-context">{{ thread.gitInfo?.branch ?? '' }}</span>
                      </span>
                    </span>
                  </button>
                  <div class="thread-row-meta">
                    <time [attr.datetime]="threadDate(thread).toISOString()">
                      {{ threadDateLabel(thread) }}
                    </time>
                    @if (relatedPullRequests(thread); as pullRequests) {
                      @if (pullRequests.length) {
                        <span class="thread-prs" aria-label="Related pull requests">
                          @for (pr of pullRequests; track pr.url) {
                            <span class="thread-pr">
                              <umbra-button
                                size="sm"
                                variant="ghost"
                                [ariaLabel]="pullRequestLabel(pr)"
                                [attr.title]="pullRequestLabel(pr)"
                                (click)="openPullRequest(pr.url)"
                              >
                                <rl-icon
                                  umbraButtonIcon
                                  name="git-pull-request"
                                  [size]="14"
                                  class="pr-status-icon"
                                  [attr.data-status]="prState(pr)"
                                />
                                {{ pr.repository }}#{{ pr.number }}
                              </umbra-button>
                              @if (pr.ciState) {
                                <span
                                  class="pr-ci-status"
                                  role="img"
                                  [attr.data-status]="pr.ciState"
                                  [attr.aria-label]="'CI ' + pr.ciState"
                                  [attr.title]="'CI ' + pr.ciState"
                                ></span>
                              }
                            </span>
                          }
                        </span>
                      }
                    }
                  </div>
                </div>
              }
              @if (group.hasMore) {
                <div class="thread-group-more">
                  <umbra-button
                    size="sm"
                    variant="outline"
                    [disabled]="loadingThreads()"
                    (click)="loadMoreGroup(group)"
                  >
                    {{
                      loadingThreads()
                        ? 'Loading…'
                        : group.hasLoadedMore
                          ? 'Show 5 more'
                          : 'Load more'
                    }}
                  </umbra-button>
                </div>
              }
            }
          }
          @if (nextCursor()) {
            <div class="load-more">
              <umbra-button
                size="sm"
                variant="outline"
                [disabled]="loadingThreads()"
                (click)="loadMoreThreads()"
              >
                {{ loadingThreads() ? 'Loading…' : 'Load older threads' }}
              </umbra-button>
            </div>
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

          <umbra-input
            label="Resume thread ID"
            [(value)]="threadId"
            [disabled]="sending()"
            placeholder="Leave blank to start a new thread"
            autocomplete="off"
          />

          <umbra-textarea
            label="Prompt"
            rows="6"
            [maxLength]="64000"
            placeholder="Describe the work for Codex…"
            [disabled]="sending()"
            [(value)]="promptText"
            (keydown.control.enter)="send(promptText())"
          />
          <p class="permission-note">
            Codex can edit this workspace and run commands without further approval. Reads include
            platform defaults. Network is disabled; requests for extra access are declined.
          </p>

          @if (error()) {
            <p class="error" role="alert">{{ error() }}</p>
          }
          <umbra-button
            size="sm"
            [disabled]="sending() || !workingDirectory() || !promptText().trim()"
            (click)="send(promptText())"
          >
            <rl-icon umbraButtonIcon [name]="sending() ? 'loader-circle' : 'command'" [size]="14" />
            {{ sending() ? 'Waiting for Codex…' : 'Send to Codex' }}
          </umbra-button>

          @if (response()) {
            <section class="response" aria-live="polite">
              <div class="response-heading">
                <h2>Codex response</h2>
                <umbra-button size="sm" variant="outline" (click)="openInCodex()">
                  Open in Codex
                </umbra-button>
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
            <div class="thread-detail-meta">
              <span
                class="thread-state"
                role="img"
                [attr.data-status]="threadStatus(thread)"
                [attr.aria-label]="'Thread status: ' + threadStatus(thread)"
                [attr.title]="threadStatus(thread)"
              ></span>
              @if (thread.model) {
                <span>{{ thread.model }}</span>
              }
              @if (thread.gitInfo?.branch) {
                <span>{{ thread.gitInfo.branch }}</span>
              }
              @if (lastTurnStatus(thread)) {
                <span>Last turn · {{ lastTurnStatus(thread) }}</span>
              }
            </div>
            @for (pr of relatedPullRequests(thread); track pr.url) {
              <div class="thread-pr-detail">
                <umbra-button
                  size="sm"
                  variant="outline"
                  (click)="openPullRequest(pr.url)"
                  [ariaLabel]="pullRequestLabel(pr)"
                >
                  <rl-icon
                    umbraButtonIcon
                    name="git-pull-request"
                    [size]="14"
                    class="pr-status-icon"
                    [attr.data-status]="prState(pr)"
                  />
                  {{ pr.repository }}#{{ pr.number }} · {{ pr.title }}
                </umbra-button>
                @if (pr.ciState) {
                  <span
                    class="pr-ci-status"
                    role="img"
                    [attr.data-status]="pr.ciState"
                    [attr.aria-label]="'CI ' + pr.ciState"
                    [attr.title]="'CI ' + pr.ciState"
                  ></span>
                }
              </div>
            }
            @if (olderCursor()) {
              <umbra-button
                size="sm"
                variant="outline"
                [disabled]="loadingEarlier()"
                (click)="loadEarlier()"
              >
                {{ loadingEarlier() ? 'Loading…' : 'Load earlier messages' }}
              </umbra-button>
            }
            @if (paginationError()) {
              <p class="error" role="alert">{{ paginationError() }}</p>
            }
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
      display: grid;
      grid-template-columns: minmax(0, 1fr) 180px;
      align-items: center;
      gap: var(--space-3);
      inline-size: 100%;
      padding: var(--space-2) var(--space-3);
      border-block-end: 1px solid var(--border-subtle);
    }

    .thread-row:has(:hover),
    .thread-row:has(:focus-visible) {
      background: var(--tint-hover);
    }

    .thread-open {
      display: block;
      width: 100%;
      min-inline-size: 0;
      padding: var(--space-1) 0;
      color: var(--text-body);
      text-align: start;
      background: transparent;
      border: 0;
    }

    .thread-open:focus-visible {
      outline: 2px solid var(--border-focus);
      outline-offset: 2px;
    }

    .thread-row-main {
      display: grid;
      min-inline-size: 0;
      gap: 2px;
    }

    .thread-row-heading,
    .thread-row-description {
      display: flex;
      align-items: center;
      min-inline-size: 0;
      gap: var(--space-2);
    }

    .thread-row-title {
      min-inline-size: 0;
      overflow: hidden;
      color: var(--text-strong);
      font-size: var(--text-13);
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .thread-row-preview,
    .thread-row-context,
    .thread-row-meta time,
    .thread-location {
      color: var(--text-muted);
      font-size: var(--text-12);
    }

    .thread-row-preview,
    .thread-row-context {
      flex: 0 1 auto;
      min-inline-size: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .thread-row-separator {
      flex: none;
      color: var(--text-subtle);
    }

    .thread-state {
      display: inline-block;
      inline-size: 9px;
      block-size: 9px;
      flex: none;
      background: var(--status-idle);
      border-radius: 50%;
    }
    .thread-state[data-status='Active'] {
      background: var(--status-running);
    }
    .thread-state[data-status='Waiting for approval'],
    .thread-state[data-status='Waiting for input'] {
      background: var(--status-waiting);
    }
    .thread-state[data-status='System error'] {
      background: var(--status-blocked);
    }
    .thread-prs {
      display: flex;
      align-items: center;
      justify-content: end;
      gap: var(--space-1);
      max-inline-size: 100%;
      min-inline-size: 0;
      overflow: hidden;
    }

    .thread-group-heading {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin: var(--space-4) 0 0;
    }

    .thread-row-meta {
      display: grid;
      grid-template-rows: auto 1fr;
      align-self: stretch;
      justify-items: end;
      gap: var(--space-1);
      min-inline-size: 0;
    }

    .thread-pr {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      min-inline-size: 0;
    }

    :host ::ng-deep .thread-pr .umbra-button {
      min-inline-size: 0;
      padding-inline: var(--space-2);
    }

    .thread-pr-detail {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      max-inline-size: 100%;
    }

    :host ::ng-deep .thread-pr-detail .umbra-button {
      max-inline-size: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    :host ::ng-deep .thread-pr .pr-status-icon[data-status='merged'] {
      color: var(--status-done);
    }
    :host ::ng-deep .thread-pr .pr-status-icon[data-status='closed'] {
      color: var(--status-idle);
    }
    :host ::ng-deep .thread-pr .pr-status-icon[data-status='open'] {
      color: var(--status-running);
    }

    .pr-ci-status {
      inline-size: 6px;
      block-size: 6px;
      flex: none;
      border-radius: var(--radius-pill);
      background: var(--status-idle);
    }
    .pr-ci-status[data-status='failure'] {
      color: var(--status-blocked);
      background: var(--status-blocked);
    }
    .pr-ci-status[data-status='pending'] {
      color: var(--status-waiting);
      background: var(--status-waiting);
    }
    .pr-ci-status[data-status='success'] {
      color: var(--status-done);
      background: var(--status-done);
    }
    .thread-detail-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-3);
      color: var(--text-muted);
      font-size: var(--text-12);
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
        grid-template-columns: minmax(0, 1fr);
        gap: var(--space-1) var(--space-3);
      }

      .thread-row-meta {
        grid-column: 1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-inline-start: calc(9px + var(--space-2));
      }

      .thread-row-meta:not(:has(.thread-prs)) time {
        margin-inline-start: auto;
      }

      .thread-prs {
        justify-content: start;
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
  private openGeneration = 0;
  readonly openThreadId = input<string | null>(null);
  readonly threadHandled = output<void>();

  protected readonly screen = signal<'history' | 'compose' | 'thread'>('history');
  protected readonly workspaces = signal<readonly WorkspaceSummary[]>([]);
  protected readonly workingDirectory = signal('');
  protected readonly threadId = signal('');
  protected readonly threads = signal<readonly CodexThreadSummary[]>([]);
  protected readonly visibleThreadCounts = signal<Record<string, number>>({});
  protected readonly threadGroups = computed(() => {
    const groups = new Map<string, CodexThreadSummary[]>();
    for (const thread of this.threads()) {
      const group = groups.get(thread.cwd);
      if (group) group.push(thread);
      else groups.set(thread.cwd, [thread]);
    }

    return [...groups]
      .map(([key, threads]) => {
        threads.sort((a, b) => this.threadTimestamp(b) - this.threadTimestamp(a));
        const visibleCount = this.visibleThreadCounts()[key] ?? 5;
        return {
          key,
          label: this.threadGroupLabel(threads[0]),
          threads,
          visibleThreads: threads.slice(0, visibleCount),
          hasLoadedMore: threads.length > visibleCount,
          hasMore: threads.length > visibleCount || this.nextCursor() !== null,
        };
      })
      .sort((a, b) => this.threadTimestamp(b.threads[0]) - this.threadTimestamp(a.threads[0]));
  });
  protected readonly pullRequests = signal<readonly GithubPullRequestSummary[]>([]);
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
  protected readonly olderCursor = signal<string | null>(null);
  protected readonly loadingEarlier = signal(false);
  protected readonly paginationError = signal('');

  constructor() {
    void this.loadWorkspaces();
    void this.loadThreads(true);
    effect(() => {
      const id = this.openThreadId();
      if (id) void this.openThread(id).finally(() => this.threadHandled.emit());
    });
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
    this.openGeneration++;
    this.loadingThread.set(false);
    this.threadId.set('');
    this.response.set('');
    this.error.set('');
    this.screen.set('compose');
  }

  protected showHistory(): void {
    this.openGeneration++;
    this.loadingThread.set(false);
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
    const generation = ++this.openGeneration;
    this.threadId.set(threadId);
    this.screen.set('thread');
    this.loadingThread.set(true);
    this.threadError.set('');
    this.activeThread.set(null);
    this.olderCursor.set(null);
    this.loadingEarlier.set(false);
    this.paginationError.set('');
    try {
      const details = await this.tauri.codexReadThread(threadId);
      if (generation !== this.openGeneration) return;
      this.activeThread.set(details.thread);
      this.olderCursor.set(details.olderCursor);
    } catch (cause: unknown) {
      if (generation === this.openGeneration)
        this.threadError.set(errorMessage(cause, 'Could not load this Codex thread.'));
    } finally {
      if (generation === this.openGeneration) this.loadingThread.set(false);
    }
  }

  protected async loadEarlier(): Promise<void> {
    const thread = this.activeThread();
    const cursor = this.olderCursor();
    if (!thread || !cursor || this.loadingEarlier()) return;
    const generation = this.openGeneration;
    this.loadingEarlier.set(true);
    this.paginationError.set('');
    try {
      const page = await this.tauri.codexOlderTurns(thread.id, cursor);
      if (generation !== this.openGeneration) return;
      this.activeThread.update((current) =>
        current ? { ...current, turns: [...page.turns, ...current.turns] } : current,
      );
      this.olderCursor.set(page.nextCursor);
    } catch (cause: unknown) {
      if (generation === this.openGeneration)
        this.paginationError.set(errorMessage(cause, 'Could not load earlier messages.'));
    } finally {
      if (generation === this.openGeneration) this.loadingEarlier.set(false);
    }
  }

  protected async loadMoreThreads(): Promise<void> {
    await this.loadThreads(false);
  }

  protected async loadMoreGroup(group: { key: string; hasLoadedMore: boolean }): Promise<void> {
    this.visibleThreadCounts.update((counts) => ({
      ...counts,
      [group.key]: (counts[group.key] ?? 5) + 5,
    }));
    if (!group.hasLoadedMore) await this.loadThreads(false);
  }

  protected summaryTitle(thread: CodexThreadSummary): string {
    return codexThreadTitle(thread);
  }

  protected summaryPreview(thread: CodexThreadSummary): string {
    const preview = codexThreadPreview(thread.preview);
    return preview && preview !== this.summaryTitle(thread) ? preview : this.threadLocation(thread);
  }

  protected threadLocation(thread: CodexThreadSummary): string {
    return [
      repositoryName(thread.gitInfo?.originUrl) || pathName(thread.cwd),
      thread.gitInfo?.branch,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  protected threadGroupLabel(thread: CodexThreadSummary): string {
    return repositoryName(thread.gitInfo?.originUrl) || pathName(thread.cwd);
  }

  protected threadTimestamp(thread: CodexThreadSummary): number {
    return thread.recencyAt ?? thread.updatedAt ?? thread.createdAt;
  }

  protected threadStatus(thread: CodexThreadSummary): string {
    const status = thread.status;
    if (!status) return 'Status unavailable';
    if (status.type === 'notLoaded') return 'Not loaded';
    if (status.type === 'idle') return 'Idle';
    if (status.type === 'systemError') return 'System error';
    if (status.activeFlags?.includes('waitingOnApproval')) return 'Waiting for approval';
    if (status.activeFlags?.includes('waitingOnUserInput')) return 'Waiting for input';
    return 'Active';
  }

  protected lastTurnStatus(thread: CodexThread): string {
    return (
      thread.turns
        .at(-1)
        ?.status.replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase() ?? ''
    );
  }

  protected relatedPullRequests(thread: CodexThreadSummary): readonly GithubPullRequestSummary[] {
    const repo = repositoryName(thread.gitInfo?.originUrl)?.toLowerCase();
    const branch = thread.gitInfo?.branch;
    if (!repo || !branch) return [];
    return this.pullRequests().filter(
      (pr) => pr.repository.toLowerCase() === repo && pr.headBranch === branch,
    );
  }

  protected pullRequestStatus(pr: GithubPullRequestSummary): string {
    const state = pr.merged ? 'Merged' : pr.state === 'closed' ? 'Closed' : 'Open';
    return `${state}${pr.ciState ? ` · CI ${pr.ciState}` : ''}`;
  }

  protected prState(pr: GithubPullRequestSummary): 'open' | 'closed' | 'merged' {
    return pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
  }

  protected pullRequestLabel(pr: GithubPullRequestSummary): string {
    return `${pr.repository}#${pr.number}: ${pr.title}; branch ${pr.headBranch ?? 'unknown'}; ${this.pullRequestStatus(pr)}; ${pr.ciState ? `CI ${pr.ciState}` : 'CI status unavailable'}; updated ${this.pullRequestUpdated(pr)}`;
  }

  protected openPullRequest(url: string): void {
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[?#].*)?$/.test(url))
      void this.tauri.openUrl(url);
  }

  protected threadTitle(): string {
    const thread = this.activeThread();
    return thread ? codexThreadTitle(thread) : 'Codex thread';
  }

  protected threadDate(thread: CodexThreadSummary): Date {
    return new Date((thread.recencyAt ?? thread.updatedAt ?? thread.createdAt) * 1000);
  }

  protected threadDateLabel(thread: CodexThreadSummary): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(
      this.threadDate(thread),
    );
  }

  protected pullRequestUpdated(pr: GithubPullRequestSummary): string {
    return new Date(pr.lastSeen).toLocaleString();
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
      const workspaces = await this.tauri.scanWorkspaces();
      this.workspaces.set(workspaces);
      if (!this.workingDirectory()) this.workingDirectory.set(workspaces[0]?.path ?? '');
    } catch {
      this.error.set('Could not load local workspaces. Is Relay running on the desktop?');
    } finally {
      this.loadingWorkspaces.set(false);
    }
  }

  private async loadThreads(reset: boolean): Promise<void> {
    if (!this.tauri.available) {
      this.threadListError.set('Codex threads are available in the Relay desktop app.');
      return;
    }
    if (this.loadingThreads() || (!reset && !this.nextCursor())) return;
    const cursor = reset ? null : this.nextCursor();
    this.loadingThreads.set(true);
    this.threadListError.set('');
    try {
      if (reset) {
        this.visibleThreadCounts.set({});
        try {
          this.pullRequests.set(await this.tauri.githubPullRequests(true));
        } catch {
          this.pullRequests.set([]);
        }
      }
      const page = await this.tauri.codexListThreads(cursor);
      this.threads.set([
        ...new Map(
          (reset ? page.threads : [...this.threads(), ...page.threads]).map((thread) => [
            thread.id,
            thread,
          ]),
        ).values(),
      ]);
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

function pathName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function repositoryName(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin.replace(/^git@github\.com:/i, 'https://github.com/'));
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const repository = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return /^[^/]+\/[^/]+$/.test(repository) ? repository : null;
  } catch {
    return null;
  }
}
