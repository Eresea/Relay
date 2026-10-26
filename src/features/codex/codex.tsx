import { Fragment, useLayoutEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/shared/icon';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { when } from '@/lib/jsx';
import { useController, useSignals } from '@/lib/signals';
import { DestroyRef } from '@/lib/signals';
import { inject } from '@/lib/inject';
import { computed, signal } from '@/lib/signals';
import DOMPurify from 'dompurify';
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
} from '@/core/tauri';

import './codex.css';

export class CodexState {
  readonly destroyRef = new DestroyRef();
  private readonly tauri = inject(TauriBridge);
  private readonly markdownCache = new Map<string, string>();
  private openGeneration = 0;
  readonly openThreadId = signal<string | null>(null);
  onThreadHandled: () => void = () => undefined;

  readonly screen = signal<'history' | 'compose' | 'thread'>('history');
  readonly workspaces = signal<readonly WorkspaceSummary[]>([]);
  readonly workingDirectory = signal('');
  readonly threadId = signal('');
  readonly threads = signal<readonly CodexThreadSummary[]>([]);
  readonly visibleThreadCounts = signal<Record<string, number>>({});
  readonly threadGroups = computed(() => {
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
  readonly pullRequests = signal<readonly GithubPullRequestSummary[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly activeThread = signal<CodexThread | null>(null);
  readonly promptText = signal('');
  readonly response = signal('');
  readonly error = signal('');
  readonly threadError = signal('');
  readonly threadListError = signal('');
  readonly sending = signal(false);
  readonly loadingWorkspaces = signal(true);
  readonly loadingThreads = signal(false);
  readonly loadingThread = signal(false);
  readonly olderCursor = signal<string | null>(null);
  readonly loadingEarlier = signal(false);
  readonly paginationError = signal('');

  constructor() {
    void this.loadWorkspaces();
    void this.loadThreads(true);
    this.destroyRef.effect(() => {
      const id = this.openThreadId();
      if (id) void this.openThread(id).finally(() => this.onThreadHandled());
    });
  }

  async send(prompt: string): Promise<void> {
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

  newThread(): void {
    this.openGeneration++;
    this.loadingThread.set(false);
    this.threadId.set('');
    this.response.set('');
    this.error.set('');
    this.screen.set('compose');
  }

  showHistory(): void {
    this.openGeneration++;
    this.loadingThread.set(false);
    this.screen.set('history');
    void this.loadThreads(true);
  }

  continueThread(): void {
    const thread = this.activeThread();
    if (!thread) return;
    this.threadId.set(thread.id);
    this.workingDirectory.set(thread.cwd);
    this.response.set('');
    this.error.set('');
    this.screen.set('compose');
  }

  async openThread(threadId: string): Promise<void> {
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

  async loadEarlier(): Promise<void> {
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

  async loadMoreThreads(): Promise<void> {
    await this.loadThreads(false);
  }

  async loadMoreGroup(group: { key: string; hasLoadedMore: boolean }): Promise<void> {
    this.visibleThreadCounts.update((counts) => ({
      ...counts,
      [group.key]: (counts[group.key] ?? 5) + 5,
    }));
    if (!group.hasLoadedMore) await this.loadThreads(false);
  }

  summaryTitle(thread: CodexThreadSummary): string {
    return codexThreadTitle(thread);
  }

  summaryPreview(thread: CodexThreadSummary): string {
    const preview = codexThreadPreview(thread.preview);
    return preview && preview !== this.summaryTitle(thread) ? preview : this.threadLocation(thread);
  }

  threadLocation(thread: CodexThreadSummary): string {
    return [
      repositoryName(thread.gitInfo?.originUrl) || pathName(thread.cwd),
      thread.gitInfo?.branch,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  threadGroupLabel(thread: CodexThreadSummary): string {
    return repositoryName(thread.gitInfo?.originUrl) || pathName(thread.cwd);
  }

  threadTimestamp(thread: CodexThreadSummary): number {
    return thread.recencyAt ?? thread.updatedAt ?? thread.createdAt;
  }

  threadStatus(thread: CodexThreadSummary): string {
    const status = thread.status;
    if (!status) return 'Status unavailable';
    if (status.type === 'notLoaded') return 'Not loaded';
    if (status.type === 'idle') return 'Idle';
    if (status.type === 'systemError') return 'System error';
    if (status.activeFlags?.includes('waitingOnApproval')) return 'Waiting for approval';
    if (status.activeFlags?.includes('waitingOnUserInput')) return 'Waiting for input';
    return 'Active';
  }

  lastTurnStatus(thread: CodexThread): string {
    return (
      thread.turns
        .at(-1)
        ?.status.replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase() ?? ''
    );
  }

  relatedPullRequests(thread: CodexThreadSummary): readonly GithubPullRequestSummary[] {
    const repo = repositoryName(thread.gitInfo?.originUrl)?.toLowerCase();
    const branch = thread.gitInfo?.branch;
    if (!repo || !branch) return [];
    return this.pullRequests().filter(
      (pr) => pr.repository.toLowerCase() === repo && pr.headBranch === branch,
    );
  }

  pullRequestStatus(pr: GithubPullRequestSummary): string {
    const state = pr.merged ? 'Merged' : pr.state === 'closed' ? 'Closed' : 'Open';
    return `${state}${pr.ciState ? ` · CI ${pr.ciState}` : ''}`;
  }

  prState(pr: GithubPullRequestSummary): 'open' | 'closed' | 'merged' {
    return pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
  }

  pullRequestLabel(pr: GithubPullRequestSummary): string {
    return `${pr.repository}#${pr.number}: ${pr.title}; branch ${pr.headBranch ?? 'unknown'}; ${this.pullRequestStatus(pr)}; ${pr.ciState ? `CI ${pr.ciState}` : 'CI status unavailable'}; updated ${this.pullRequestUpdated(pr)}`;
  }

  openPullRequest(url: string): void {
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[?#].*)?$/.test(url))
      void this.tauri.openUrl(url);
  }

  threadTitle(): string {
    const thread = this.activeThread();
    return thread ? codexThreadTitle(thread) : 'Codex thread';
  }

  threadDate(thread: CodexThreadSummary): Date {
    return new Date((thread.recencyAt ?? thread.updatedAt ?? thread.createdAt) * 1000);
  }

  threadDateLabel(thread: CodexThreadSummary): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(
      this.threadDate(thread),
    );
  }

  pullRequestUpdated(pr: GithubPullRequestSummary): string {
    return new Date(pr.lastSeen).toLocaleString();
  }

  userContent(item: CodexThreadItem): readonly Record<string, unknown>[] {
    const content = item['content'];
    return Array.isArray(content)
      ? content.filter(
          (value): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null && !Array.isArray(value),
        )
      : [];
  }

  contentLabel(content: Record<string, unknown>): string {
    const type = this.asString(content['type']);
    const detail = this.asString(content['path'] ?? content['url'] ?? content['name']);
    return `${type || 'Attachment'}${detail ? ` · ${detail}` : ''}`;
  }

  itemTitle(item: CodexThreadItem): string {
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

  itemDetails(item: CodexThreadItem): string {
    return JSON.stringify(item, null, 2) ?? '';
  }

  asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  renderMarkdown(text: string): string {
    const cached = this.markdownCache.get(text);
    if (cached !== undefined) return cached;
    const rendered = marked.parse(text, { async: false });
    // Agent-written Markdown becomes HTML: sanitize before it reaches the DOM.
    const safe = DOMPurify.sanitize(rendered);
    this.markdownCache.set(text, safe);
    return safe;
  }

  openInCodex(): void {
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

export default function Codex(props: {
  openThreadId?: string | null;
  onThreadHandled?: () => void;
}) {
  useSignals();
  const s = useController(() => {
    const state = new CodexState();
    if (props.openThreadId !== undefined) state.openThreadId.set(props.openThreadId);
    return state;
  });
  useLayoutEffect(() => {
    if (props.openThreadId !== undefined) s.openThreadId.set(props.openThreadId);
  }, [s, props.openThreadId]);
  if (props.onThreadHandled) s.onThreadHandled = props.onThreadHandled;
  return (
    <div className="codex">
      <section className="codex" aria-labelledby="codex-title">
        <header className="page-header">
          <div>
            <p className="u-caption">Local Codex</p>
            {s.screen() === 'history' ? (
              <>
                <h1 id="codex-title">Threads</h1>
              </>
            ) : s.screen() === 'compose' ? (
              <>
                <h1 id="codex-title">Send work to Codex</h1>
              </>
            ) : (
              <>
                <h1 id="codex-title">{s.threadTitle()}</h1>
              </>
            )}
          </div>
          {s.screen() === 'history' ? (
            <>
              <div className="thread-actions">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={s.loadingThreads()}
                  onClick={() => {
                    void s.showHistory();
                  }}
                >
                  Refresh
                </Button>
                <Button
                  size="sm"
                  disabled={s.sending()}
                  onClick={() => {
                    void s.newThread();
                  }}
                >
                  <Icon name="plus" size={14} />
                  New thread
                </Button>
              </div>
            </>
          ) : s.screen() === 'compose' ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void s.showHistory();
                }}
              >
                Threads
              </Button>
            </>
          ) : (
            <>
              <div className="thread-actions">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void s.showHistory();
                  }}
                >
                  All threads
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={s.loadingThread() || !s.activeThread()}
                  onClick={() => {
                    void s.openInCodex();
                  }}
                >
                  Open in Codex
                </Button>
                <Button
                  size="sm"
                  disabled={s.loadingThread() || !s.activeThread()}
                  onClick={() => {
                    void s.continueThread();
                  }}
                >
                  <Icon name="chevron-right" size={14} />
                  Continue
                </Button>
              </div>
            </>
          )}
        </header>

        {s.screen() === 'history' ? (
          <>
            <div className="thread-list" aria-label="Local Codex threads">
              {s.threadListError() ? (
                <>
                  <p className="error" role="alert">
                    {s.threadListError()}
                  </p>
                </>
              ) : null}
              {s.loadingThreads() && s.threads().length === 0 ? (
                <>
                  <p className="state" role="status">
                    Loading Codex threads…
                  </p>
                </>
              ) : s.threads().length === 0 && !s.threadListError() ? (
                <>
                  <p className="state" role="status">
                    No local Codex threads yet.
                  </p>
                </>
              ) : (
                <>
                  {s.threadGroups().map((group) => {
                    return (
                      <Fragment key={group.key}>
                        <h2 className="thread-group-heading u-caption">
                          <span>{group.label}</span>
                          <span className="u-mono">{group.threads.length}</span>
                        </h2>
                        {group.visibleThreads.map((thread) => {
                          return (
                            <Fragment key={thread.id}>
                              <div className="thread-row">
                                <button
                                  className="thread-open"
                                  type="button"
                                  disabled={s.loadingThread()}
                                  onClick={() => {
                                    void s.openThread(thread.id);
                                  }}
                                >
                                  <span className="thread-row-main">
                                    <span className="thread-row-heading">
                                      <span
                                        className="thread-state"
                                        role="img"
                                        data-status={s.threadStatus(thread)}
                                        aria-label={'Thread status: ' + s.threadStatus(thread)}
                                        title={s.threadStatus(thread)}
                                      />
                                      <span className="thread-row-title">
                                        {s.summaryTitle(thread)}
                                      </span>
                                    </span>
                                    <span className="thread-row-description">
                                      {s.summaryPreview(thread) !== s.threadLocation(thread) ? (
                                        <>
                                          <span className="thread-row-preview">
                                            {s.summaryPreview(thread)}
                                          </span>
                                          <span className="thread-row-separator" aria-hidden="true">
                                            ·
                                          </span>
                                        </>
                                      ) : null}
                                      <span className="thread-row-context">
                                        {thread.gitInfo?.branch ?? ''}
                                      </span>
                                    </span>
                                  </span>
                                </button>
                                <div className="thread-row-meta">
                                  <time dateTime={s.threadDate(thread).toISOString()}>
                                    {s.threadDateLabel(thread)}
                                  </time>
                                  {when(s.relatedPullRequests(thread), (pullRequests) => (
                                    <>
                                      {pullRequests.length ? (
                                        <>
                                          <span
                                            className="thread-prs"
                                            aria-label="Related pull requests"
                                          >
                                            {pullRequests.map((pr) => {
                                              return (
                                                <Fragment key={pr.url}>
                                                  <span className="thread-pr">
                                                    <Button
                                                      size="sm"
                                                      variant="ghost"
                                                      aria-label={s.pullRequestLabel(pr)}
                                                      title={s.pullRequestLabel(pr)}
                                                      onClick={() => {
                                                        void s.openPullRequest(pr.url);
                                                      }}
                                                    >
                                                      <Icon
                                                        className="pr-status-icon"
                                                        name="git-pull-request"
                                                        size={14}
                                                        data-status={s.prState(pr)}
                                                      />
                                                      {pr.repository}#{pr.number}
                                                    </Button>
                                                    {pr.ciState ? (
                                                      <>
                                                        <span
                                                          className="pr-ci-status"
                                                          role="img"
                                                          data-status={pr.ciState}
                                                          aria-label={'CI ' + pr.ciState}
                                                          title={'CI ' + pr.ciState}
                                                        />
                                                      </>
                                                    ) : null}
                                                  </span>
                                                </Fragment>
                                              );
                                            })}
                                          </span>
                                        </>
                                      ) : null}
                                    </>
                                  ))}
                                </div>
                              </div>
                            </Fragment>
                          );
                        })}
                        {group.hasMore ? (
                          <>
                            <div className="thread-group-more">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={s.loadingThreads()}
                                onClick={() => {
                                  void s.loadMoreGroup(group);
                                }}
                              >
                                {s.loadingThreads()
                                  ? 'Loading…'
                                  : group.hasLoadedMore
                                    ? 'Show 5 more'
                                    : 'Load more'}
                              </Button>
                            </div>
                          </>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </>
              )}
              {s.nextCursor() ? (
                <>
                  <div className="load-more">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={s.loadingThreads()}
                      onClick={() => {
                        void s.loadMoreThreads();
                      }}
                    >
                      {s.loadingThreads() ? 'Loading…' : 'Load older threads'}
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          </>
        ) : null}

        {s.screen() === 'compose' ? (
          <>
            <div className="form">
              <label>
                Workspace
                <select
                  value={s.workingDirectory()}
                  onChange={($event) => {
                    void s.workingDirectory.set($event.currentTarget.value);
                  }}
                  disabled={s.sending() || s.loadingWorkspaces() || s.workspaces().length === 0}
                >
                  {s.workspaces().map((workspace) => {
                    return (
                      <Fragment key={workspace.path}>
                        <option value={workspace.path}>
                          {workspace.name} — {workspace.path}
                        </option>
                      </Fragment>
                    );
                  })}
                </select>
              </label>
              {s.workspaces().length === 0 && !s.loadingWorkspaces() ? (
                <>
                  <p className="state" role="status">
                    Relay has not discovered a local Git workspace yet.
                  </p>
                </>
              ) : null}

              <Input
                label="Resume thread ID"
                value={s.threadId()}
                onValueChange={(value) => {
                  s.threadId.set(value);
                }}
                disabled={s.sending()}
                placeholder="Leave blank to start a new thread"
                autoComplete="off"
              />

              <Textarea
                label="Prompt"
                rows={6}
                maxLength={64000}
                placeholder="Describe the work for Codex…"
                disabled={s.sending()}
                value={s.promptText()}
                onValueChange={(value) => {
                  s.promptText.set(value);
                }}
                onKeyDown={($event) => {
                  if ($event.ctrlKey && $event.key === 'Enter') {
                    void s.send(s.promptText());
                  }
                }}
              />
              <p className="permission-note">
                Codex can edit this workspace and run commands without further approval. Reads
                include platform defaults. Network is disabled; requests for extra access are
                declined.
              </p>

              {s.error() ? (
                <>
                  <p className="error" role="alert">
                    {s.error()}
                  </p>
                </>
              ) : null}
              <Button
                size="sm"
                disabled={s.sending() || !s.workingDirectory() || !s.promptText().trim()}
                onClick={() => {
                  void s.send(s.promptText());
                }}
              >
                <Icon name={s.sending() ? 'loader-circle' : 'command'} size={14} />
                {s.sending() ? 'Waiting for Codex…' : 'Send to Codex'}
              </Button>

              {s.response() ? (
                <>
                  <section className="response" aria-live="polite">
                    <div className="response-heading">
                      <h2>Codex response</h2>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void s.openInCodex();
                        }}
                      >
                        Open in Codex
                      </Button>
                    </div>
                    <pre>{s.response()}</pre>
                  </section>
                </>
              ) : null}
            </div>
          </>
        ) : null}

        {s.screen() === 'thread' ? (
          <>
            {s.loadingThread() ? (
              <>
                <p className="state" role="status">
                  Loading thread…
                </p>
              </>
            ) : s.threadError() ? (
              <>
                <p className="error" role="alert">
                  {s.threadError()}
                </p>
              </>
            ) : (
              when(s.activeThread(), (thread) => (
                <>
                  <div className="thread-detail">
                    <p className="thread-location">{thread.cwd}</p>
                    <div className="thread-detail-meta">
                      <span
                        className="thread-state"
                        role="img"
                        data-status={s.threadStatus(thread)}
                        aria-label={'Thread status: ' + s.threadStatus(thread)}
                        title={s.threadStatus(thread)}
                      />
                      {thread.model ? (
                        <>
                          <span>{thread.model}</span>
                        </>
                      ) : null}
                      {thread.gitInfo?.branch ? (
                        <>
                          <span>{thread.gitInfo.branch}</span>
                        </>
                      ) : null}
                      {s.lastTurnStatus(thread) ? (
                        <>
                          <span>Last turn · {s.lastTurnStatus(thread)}</span>
                        </>
                      ) : null}
                    </div>
                    {s.relatedPullRequests(thread).map((pr) => {
                      return (
                        <Fragment key={pr.url}>
                          <div className="thread-pr-detail">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                void s.openPullRequest(pr.url);
                              }}
                              aria-label={s.pullRequestLabel(pr)}
                            >
                              <Icon
                                className="pr-status-icon"
                                name="git-pull-request"
                                size={14}
                                data-status={s.prState(pr)}
                              />
                              {pr.repository}#{pr.number} · {pr.title}
                            </Button>
                            {pr.ciState ? (
                              <>
                                <span
                                  className="pr-ci-status"
                                  role="img"
                                  data-status={pr.ciState}
                                  aria-label={'CI ' + pr.ciState}
                                  title={'CI ' + pr.ciState}
                                />
                              </>
                            ) : null}
                          </div>
                        </Fragment>
                      );
                    })}
                    {s.olderCursor() ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={s.loadingEarlier()}
                          onClick={() => {
                            void s.loadEarlier();
                          }}
                        >
                          {s.loadingEarlier() ? 'Loading…' : 'Load earlier messages'}
                        </Button>
                      </>
                    ) : null}
                    {s.paginationError() ? (
                      <>
                        <p className="error" role="alert">
                          {s.paginationError()}
                        </p>
                      </>
                    ) : null}
                    {thread.turns.length === 0 ? (
                      <>
                        <p className="state">This thread has no messages.</p>
                      </>
                    ) : null}
                    {thread.turns.map((turn) => {
                      return (
                        <Fragment key={turn.id}>
                          <section className="turn" aria-label={'Turn ' + turn.status}>
                            {turn.items.map((item, $index) => {
                              return (
                                <Fragment key={item.id ?? $index}>
                                  {item.type === 'userMessage' ? (
                                    <>
                                      <article className="message user-message">
                                        <h2>You</h2>
                                        {s.userContent(item).map((content, $index) => {
                                          return (
                                            <Fragment key={$index}>
                                              {content['type'] === 'text' ? (
                                                <>
                                                  <div
                                                    className="markdown"
                                                    dangerouslySetInnerHTML={{
                                                      __html: s.renderMarkdown(
                                                        s.asString(content['text']),
                                                      ),
                                                    }}
                                                  />
                                                </>
                                              ) : (
                                                <>
                                                  <p className="attachment">
                                                    {s.contentLabel(content)}
                                                  </p>
                                                </>
                                              )}
                                            </Fragment>
                                          );
                                        })}
                                      </article>
                                    </>
                                  ) : item.type === 'agentMessage' || item.type === 'plan' ? (
                                    <>
                                      <article className="message agent-message">
                                        <h2>{item.type === 'plan' ? 'Plan' : 'Codex'}</h2>
                                        <div
                                          className="markdown"
                                          dangerouslySetInnerHTML={{
                                            __html: s.renderMarkdown(s.asString(item['text'])),
                                          }}
                                        />
                                      </article>
                                    </>
                                  ) : (
                                    <>
                                      <details className="thread-item">
                                        <summary>{s.itemTitle(item)}</summary>
                                        <pre>{s.itemDetails(item)}</pre>
                                      </details>
                                    </>
                                  )}
                                </Fragment>
                              );
                            })}
                          </section>
                        </Fragment>
                      );
                    })}
                  </div>
                </>
              ))
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}
