import { Fragment, useEffect, useRef, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { hueFor, hueVar } from '@/core/entity-hue';
import type { AppEvent, NotificationAction, NotificationStatus } from '@/core/events';
import {
  TauriBridge,
  type CodexModel,
  type GithubPullRequestSummary,
  type ModelChoice,
  type WorkspaceSummary,
} from '@/core/tauri';
import { ago, folderName } from '@/features/palette/omnibar';
import { inject } from '@/lib/inject';
import { computed, signal, useController, useSignals } from '@/lib/signals';
import { cn, vars } from '@/lib/utils';
import { Icon } from '@/shared/icon';
import { renderMarkdown } from '@/shared/markdown';

import {
  AGENTS,
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  DEFAULT_CHOICES,
  chatFromLink,
  codexEntries,
  effortLabel,
  formatUsd,
  fromClaude,
  fromClaudeSummary,
  fromCodex,
  fromCodexSummary,
  merge,
  loadChoices,
  saveChoices,
  steps,
  type Agent,
  type Chat,
  type ChatSummary,
  type Choices,
} from './chat';
import './agents.css';

const message = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : fallback;

/** A turn in flight: a background job, followed through its notifications. */
interface Pending {
  readonly jobId: string;
  readonly agent: Agent;
  /** Null until a new conversation's first turn names it. */
  readonly id: string | null;
  readonly prompt: string;
  readonly status: NotificationStatus;
  readonly detail: string;
  readonly actions: readonly NotificationAction[];
}

/** Which conversation a view or a turn belongs to; "new" is the draft. */
const keyOf = (agent: Agent, id: string | null) => (id ? `${agent}:${id}` : 'new');

export type ChatRequest = { readonly agent: Agent; readonly id: string } | null;

export class AgentsState {
  private readonly tauri = inject(TauriBridge);

  readonly filter = signal<'all' | Agent>('all');
  readonly codexChats = signal<readonly ChatSummary[]>([]);
  readonly claudeChats = signal<readonly ChatSummary[]>([]);
  readonly codexCursor = signal<string | null>(null);
  readonly codexError = signal<string | null>(null);
  readonly claudeError = signal<string | null>(null);
  readonly loading = signal(true);
  readonly list = computed(() => {
    const filter = this.filter();
    return merge(
      filter === 'claude' ? [] : this.codexChats(),
      filter === 'codex' ? [] : this.claudeChats(),
    );
  });

  readonly chat = signal<Chat | null>(null);
  readonly chatError = signal<string | null>(null);
  readonly loadingChat = signal(false);
  /** Codex pages long threads; this reaches further back. */
  readonly olderCursor = signal<string | null>(null);
  readonly loadingEarlier = signal(false);
  private openGeneration = 0;

  readonly workspaces = signal<readonly WorkspaceSummary[]>([]);
  readonly workspace = signal('');
  readonly choices = signal<Choices>(DEFAULT_CHOICES);
  readonly codexModels = signal<readonly CodexModel[]>([]);
  readonly pullRequests = signal<readonly GithubPullRequestSummary[]>([]);

  readonly prompt = signal('');
  readonly sendError = signal<string | null>(null);
  /** What the turn just finished here cost, once known. */
  readonly lastTurn = signal<string | null>(null);
  readonly pending = signal<Readonly<Record<string, Pending>>>({});

  /** The agent the composer talks to: the open conversation's, or your pick for a new one. */
  readonly agent = computed<Agent>(() => this.chat()?.agent ?? this.choices().agent);
  readonly choice = computed<ModelChoice>(() => this.choices()[this.agent()]);
  readonly viewKey = computed(() => {
    const chat = this.chat();
    return chat ? keyOf(chat.agent, chat.id) : 'new';
  });
  readonly current = computed(() => this.pending()[this.viewKey()] ?? null);

  readonly models = computed(() =>
    this.agent() === 'claude'
      ? CLAUDE_MODELS
      : this.codexModels().map((m) => ({ id: m.id, name: m.name })),
  );
  readonly efforts = computed(() => {
    if (this.agent() === 'claude') return CLAUDE_EFFORTS;
    const models = this.codexModels();
    const model =
      models.find((m) => m.id === this.choice().model) ?? models.find((m) => m.isDefault);
    return model?.efforts ?? [];
  });
  /** What "Default" means for the open agent, when the agent says. */
  readonly defaults = computed(() => {
    if (this.agent() === 'claude') return { model: null, effort: null };
    const models = this.codexModels();
    const fallback = models.find((m) => m.isDefault);
    const model = models.find((m) => m.id === this.choice().model) ?? fallback;
    return { model: fallback?.name ?? null, effort: model?.defaultEffort ?? null };
  });

  /** Loads everything and follows turns in flight; returns the disposer. */
  start(): () => void {
    void this.loadAll();
    void this.tauri.scanWorkspaces().then(
      (workspaces) => {
        this.workspaces.set(workspaces);
        if (!this.workspace()) this.workspace.set(workspaces[0]?.path ?? '');
      },
      () => this.workspaces.set([]),
    );
    // A pick made while the store is still being read wins over what it had.
    void loadChoices(this.tauri).then((choices) => {
      if (this.choices() === DEFAULT_CHOICES) this.choices.set(choices);
    });
    void this.tauri.codexModels().then(
      (models) => this.codexModels.set(models),
      () => this.codexModels.set([]),
    );
    void this.tauri.githubPullRequests(true).then(
      (prs) => this.pullRequests.set(prs),
      () => this.pullRequests.set([]),
    );
    const stop = this.tauri.onEvent((event) => this.onEvent(event));
    return () => void stop.then((unlisten) => unlisten());
  }

  async loadAll(): Promise<void> {
    await Promise.all([this.loadClaude(), this.loadCodex(true)]);
    this.loading.set(false);
  }

  private async loadClaude(): Promise<void> {
    try {
      this.claudeChats.set((await this.tauri.claudeListSessions()).map(fromClaudeSummary));
      this.claudeError.set(null);
    } catch (cause) {
      this.claudeError.set(message(cause, 'Could not read Claude Code sessions.'));
    }
  }

  async loadCodex(reset: boolean): Promise<void> {
    if (!reset && !this.codexCursor()) return;
    try {
      const page = await this.tauri.codexListThreads(reset ? null : this.codexCursor());
      const threads = page.threads.map(fromCodexSummary);
      this.codexChats.update((chats) => (reset ? threads : [...chats, ...threads]));
      this.codexCursor.set(page.nextCursor);
      this.codexError.set(null);
    } catch (cause) {
      this.codexError.set(message(cause, 'Could not read Codex threads.'));
    }
  }

  async open(agent: Agent, id: string): Promise<void> {
    const generation = ++this.openGeneration;
    this.chatError.set(null);
    this.sendError.set(null);
    this.lastTurn.set(null);
    this.loadingChat.set(true);
    try {
      if (agent === 'claude') {
        const session = await this.tauri.claudeReadSession(id);
        if (generation !== this.openGeneration) return;
        this.chat.set(fromClaude(session));
        this.olderCursor.set(null);
      } else {
        const details = await this.tauri.codexReadThread(id);
        if (generation !== this.openGeneration) return;
        this.chat.set(fromCodex(details.thread));
        this.olderCursor.set(details.olderCursor);
      }
    } catch (cause) {
      if (generation !== this.openGeneration) return;
      this.chat.set(null);
      this.chatError.set(message(cause, 'Could not read that conversation.'));
    } finally {
      if (generation === this.openGeneration) this.loadingChat.set(false);
    }
  }

  async loadEarlier(): Promise<void> {
    const chat = this.chat();
    const cursor = this.olderCursor();
    if (chat?.agent !== 'codex' || !cursor || this.loadingEarlier()) return;
    const generation = this.openGeneration;
    this.loadingEarlier.set(true);
    try {
      const page = await this.tauri.codexOlderTurns(chat.id, cursor);
      if (generation !== this.openGeneration) return;
      const earlier = page.turns.flatMap((turn) => turn.items.flatMap(codexEntries));
      this.chat.update((c) => c && { ...c, entries: [...earlier, ...c.entries] });
      this.olderCursor.set(page.nextCursor);
    } catch (cause) {
      if (generation === this.openGeneration)
        this.chatError.set(message(cause, 'Could not load earlier messages.'));
    } finally {
      if (generation === this.openGeneration) this.loadingEarlier.set(false);
    }
  }

  newChat(): void {
    this.openGeneration++;
    this.chat.set(null);
    this.chatError.set(null);
    this.sendError.set(null);
    this.lastTurn.set(null);
    this.olderCursor.set(null);
    this.loadingChat.set(false);
  }

  /** Picks the agent for a new conversation; an open one keeps its own. */
  pickAgent(agent: Agent): void {
    this.remember({ ...this.choices(), agent });
  }

  pickModel(model: string): void {
    const agent = this.agent();
    // A different Codex model may not offer the effort you had.
    const effort = agent === 'codex' ? null : this.choice().effort;
    this.remember({ ...this.choices(), [agent]: { model: model || null, effort } });
  }

  pickEffort(effort: string): void {
    const agent = this.agent();
    this.remember({ ...this.choices(), [agent]: { ...this.choice(), effort: effort || null } });
  }

  private remember(choices: Choices): void {
    this.choices.set(choices);
    void saveChoices(this.tauri, choices).catch(() => undefined);
  }

  /** Starts a turn as a background job: in the open conversation, or a new one. */
  async send(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const prompt = this.prompt().trim();
    const chat = this.chat();
    const agent = this.agent();
    const cwd = chat?.cwd ?? this.workspace();
    const key = this.viewKey();
    if (!prompt || !cwd || this.pending()[key]) return;
    this.sendError.set(null);
    this.lastTurn.set(null);
    try {
      const choice = this.choice();
      const id = chat?.id ?? null;
      const jobId =
        agent === 'claude'
          ? await this.tauri.claudeAsk(prompt, cwd, id, choice)
          : await this.tauri.codexAsk(prompt, cwd, id, choice);
      if (!jobId) throw new Error(`${AGENTS[agent].label} is not available here.`);
      this.prompt.set('');
      this.pending.update((all) => ({
        ...all,
        [key]: { jobId, agent, id, prompt, status: 'running', detail: '', actions: [] },
      }));
    } catch (cause) {
      this.sendError.set(message(cause, `${AGENTS[agent].label} could not start.`));
    }
  }

  answer(pending: Pending, action: NotificationAction): void {
    void this.tauri.runNotificationAction(action, pending.jobId);
  }

  private onEvent(event: AppEvent): void {
    if (event.type !== 'notification' && event.type !== 'notificationDone') return;
    const entry = Object.entries(this.pending()).find(([, p]) => p.jobId === event.jobId);
    if (!entry) return;
    const [key, pending] = entry;
    if (event.type === 'notificationDone') {
      void this.finish(key, pending, event.ok);
      return;
    }
    const link = event.actions?.find((a) => a.id === 'open');
    const named = link?.id === 'open' ? chatFromLink(link.url) : null;
    this.pending.update((all) => ({
      ...all,
      [key]: {
        ...pending,
        id: pending.id ?? named?.id ?? null,
        status: event.status,
        detail: event.detail ?? '',
        actions: event.actions ?? [],
      },
    }));
  }

  private async finish(key: string, pending: Pending, ok: boolean): Promise<void> {
    const viewing = this.viewKey() === key;
    const before = this.chat()?.spend?.usd ?? 0;
    this.pending.update(({ [key]: _done, ...rest }) => rest);
    if (viewing && !ok) {
      this.sendError.set(pending.detail || `${AGENTS[pending.agent].label} could not finish.`);
      // Nothing was answered; keep what you wrote.
      if (!this.prompt()) this.prompt.set(pending.prompt);
    }
    // The turn stays where you started it: open its conversation if you are still there.
    if (viewing && pending.id) {
      await this.open(pending.agent, pending.id);
      const after = this.chat()?.spend?.usd;
      if (ok && after !== undefined && after > before) {
        this.lastTurn.set(`That turn cost ${formatUsd(after - before)}.`);
      }
    }
    void (pending.agent === 'claude' ? this.loadClaude() : this.loadCodex(true));
  }

  /** Pull requests from the open conversation's branch. */
  relatedPullRequests(chat: Chat): readonly GithubPullRequestSummary[] {
    if (!chat.branch || !chat.repository) return [];
    const repo = chat.repository.toLowerCase();
    return this.pullRequests().filter(
      (pr) => pr.repository.toLowerCase() === repo && pr.headBranch === chat.branch,
    );
  }

  openUrl(url: string): void {
    void this.tauri.openUrl(url);
  }
}

const agentTone = (agent: Agent) => vars({ '--agent-hue': hueVar(hueFor(agent)) });

/**
 * The Agents tab: Codex threads and Claude Code sessions in one list, the
 * open conversation with its reasoning and steps, and one composer that picks
 * the agent, its model and how hard it thinks.
 */
export default function Agents({
  request,
  onRequestHandled,
}: {
  request: ChatRequest;
  onRequestHandled: () => void;
}) {
  useSignals();
  const s = useController(() => new AgentsState());
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => s.start(), [s]);
  useEffect(() => {
    if (!request) return;
    void s.open(request.agent, request.id).then(onRequestHandled);
  }, [s, request, onRequestHandled]);

  const chat = s.chat();
  const current = s.current();
  const agent = s.agent();
  const choice = s.choice();
  const defaults = s.defaults();

  // New entries arrive at the bottom; follow them.
  const entries = chat?.entries.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat?.id, entries, current?.detail]);

  return (
    <section className="agents" aria-labelledby="agents-title">
      <header className="panehead">
        <h1 id="agents-title">Agents</h1>
        <div className="filter" role="group" aria-label="Show">
          {(['all', 'codex', 'claude'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={s.filter() === f}
              onClick={() => s.filter.set(f)}
            >
              {f === 'all' ? 'All' : AGENTS[f].label}
            </button>
          ))}
        </div>
        <span className="count">{s.list().length} conversations</span>
        <Button size="sm" variant="ghost" className="refresh" onClick={() => void s.loadAll()}>
          Refresh
        </Button>
        <Button size="sm" onClick={() => s.newChat()}>
          <Icon name="plus" size={14} />
          New chat
        </Button>
      </header>

      <div className="agents-body">
        <nav className="sessions" aria-label="Conversations">
          {[s.codexError(), s.claudeError()].map(
            (error, i) =>
              error && (
                <p key={i} className="note" role="alert">
                  {error}
                </p>
              ),
          )}
          {!s.loading() && s.list().length === 0 && (
            <p className="note">No conversations yet. Start one with New chat.</p>
          )}
          {s.list().map((item) => {
            const on = chat?.agent === item.agent && chat.id === item.id;
            return (
              <button
                key={keyOf(item.agent, item.id)}
                type="button"
                className={cn('session', on && 'on')}
                aria-current={on}
                onClick={() => void s.open(item.agent, item.id)}
              >
                <span className="session-title">
                  <span
                    className="agent-dot"
                    style={agentTone(item.agent)}
                    role="img"
                    aria-label={AGENTS[item.agent].label}
                    title={AGENTS[item.agent].label}
                  />
                  {item.title}
                </span>
                <span className="session-meta">
                  {[
                    folderName(item.cwd) || 'No folder',
                    ago(item.updatedAt),
                    item.model,
                    item.spend && formatUsd(item.spend.usd),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  {s.pending()[keyOf(item.agent, item.id)] && (
                    <Icon name="loader-circle" size={14} aria-label="Working" />
                  )}
                </span>
              </button>
            );
          })}
          {s.filter() !== 'claude' && s.codexCursor() && (
            <Button
              size="sm"
              variant="ghost"
              className="more"
              onClick={() => void s.loadCodex(false)}
            >
              Older Codex threads
            </Button>
          )}
        </nav>

        <article className="conversation" aria-label="Conversation">
          <header className="conversation-head">
            {chat ? (
              <>
                <h2>{chat.title}</h2>
                <p className="session-meta">
                  <span className="agent-dot" style={agentTone(chat.agent)} aria-hidden="true" />
                  {[AGENTS[chat.agent].label, chat.model, chat.effort && effortLabel(chat.effort)]
                    .filter(Boolean)
                    .join(' · ')}
                  <Icon name="folder" size={14} />
                  {chat.cwd}
                  {chat.branch && (
                    <>
                      <Icon name="git-branch" size={14} />
                      {chat.branch}
                    </>
                  )}
                </p>
                {chat.spend && (
                  <p className="session-meta">
                    Spent from Relay: {formatUsd(chat.spend.usd)} over {chat.spend.turns}{' '}
                    {chat.spend.turns === 1 ? 'turn' : 'turns'}. Turns run elsewhere are not
                    counted.
                  </p>
                )}
                <div className="head-actions">
                  {s.relatedPullRequests(chat).map((pr) => (
                    <Button
                      key={pr.url}
                      size="sm"
                      variant="outline"
                      onClick={() => s.openUrl(pr.url)}
                    >
                      <Icon name="git-pull-request" size={14} />
                      {pr.repository}#{pr.number}
                    </Button>
                  ))}
                  {chat.agent === 'codex' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => s.openUrl(`codex://threads/${encodeURIComponent(chat.id)}`)}
                    >
                      Open in Codex
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <>
                <h2>New chat</h2>
                <div className="pick" role="group" aria-label="Agent">
                  {(['claude', 'codex'] as const).map((a) => (
                    <button
                      key={a}
                      type="button"
                      aria-pressed={agent === a}
                      onClick={() => s.pickAgent(a)}
                    >
                      <span className="agent-dot" style={agentTone(a)} aria-hidden="true" />
                      {AGENTS[a].label}
                    </button>
                  ))}
                </div>
                <label className="field">
                  <span>Workspace</span>
                  <select value={s.workspace()} onChange={(e) => s.workspace.set(e.target.value)}>
                    {s.workspaces().map((w) => (
                      <option key={w.path} value={w.path}>
                        {w.name} — {w.path}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </header>

          <div className="messages" ref={scroller}>
            {s.chatError() && (
              <p className="note" role="alert">
                {s.chatError()}
              </p>
            )}
            {s.loadingChat() && <p className="note">Loading…</p>}
            {s.olderCursor() && (
              <Button
                size="sm"
                variant="outline"
                className="earlier"
                disabled={s.loadingEarlier()}
                onClick={() => void s.loadEarlier()}
              >
                {s.loadingEarlier() ? 'Loading…' : 'Load earlier messages'}
              </Button>
            )}
            {!chat && !current && !s.loadingChat() && (
              <p className="note">
                {agent === 'claude'
                  ? 'Claude reads freely; every edit or command it wants waits for your Allow.'
                  : 'Codex edits this workspace and runs commands inside its sandbox, without network.'}
              </p>
            )}
            {chat &&
              steps(chat.entries).map((entry, index) => (
                <Fragment key={index}>
                  {entry.kind === 'steps' ? (
                    <details className="steps">
                      <summary>
                        {entry.entries.length === 1
                          ? entry.entries[0].text
                          : `${entry.entries.length} steps · ${entry.entries.at(-1)?.text}`}
                      </summary>
                      <ol>
                        {entry.entries.map((step, i) => (
                          <li key={i}>
                            {step.detail ? (
                              <details>
                                <summary>{step.text}</summary>
                                <pre>{step.detail}</pre>
                              </details>
                            ) : (
                              step.text
                            )}
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : entry.kind === 'thinking' ? (
                    <details className="thinking">
                      <summary>Thinking</summary>
                      <div
                        className="markdown"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text) }}
                      />
                    </details>
                  ) : entry.kind === 'user' ? (
                    <div className="message user">
                      <p className="plain">{entry.text}</p>
                    </div>
                  ) : (
                    <div className="message assistant">
                      <span className="who">{AGENTS[chat.agent].label}</span>
                      <div
                        className="markdown"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text) }}
                      />
                    </div>
                  )}
                </Fragment>
              ))}
            {current && (
              <>
                <div className="message user">
                  <p className="plain">{current.prompt}</p>
                </div>
                <div className="working" role="status" data-status={current.status}>
                  <Icon
                    name={current.status === 'waiting' ? 'circle-alert' : 'loader-circle'}
                    size={14}
                  />
                  <span>{current.detail || `${AGENTS[current.agent].label} is thinking…`}</span>
                  {current.actions
                    .filter((a) => a.id === 'allow' || a.id === 'deny')
                    .map((action) => (
                      <Button
                        key={action.id}
                        size="sm"
                        variant={action.id === 'allow' ? 'default' : 'outline'}
                        onClick={() => s.answer(current, action)}
                      >
                        {action.label}
                      </Button>
                    ))}
                </div>
              </>
            )}
          </div>

          <form className="compose" onSubmit={(event) => void s.send(event)}>
            <textarea
              value={s.prompt()}
              onChange={(event) => s.prompt.set(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={chat ? `Reply to ${AGENTS[agent].label}` : `Ask ${AGENTS[agent].label}`}
              aria-label={`Message ${AGENTS[agent].label}`}
              rows={2}
              maxLength={64000}
            />
            <div className="compose-foot">
              <select
                aria-label="Model"
                value={choice.model ?? ''}
                onChange={(e) => s.pickModel(e.target.value)}
              >
                <option value="">
                  {defaults.model ? `Default · ${defaults.model}` : 'Default model'}
                </option>
                {s.models().map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Reasoning effort"
                value={choice.effort ?? ''}
                onChange={(e) => s.pickEffort(e.target.value)}
                disabled={s.efforts().length === 0}
              >
                <option value="">
                  {defaults.effort
                    ? `Default · ${effortLabel(defaults.effort)}`
                    : 'Default reasoning'}
                </option>
                {s.efforts().map((effort) => (
                  <option key={effort} value={effort}>
                    {effortLabel(effort)}
                  </option>
                ))}
              </select>
              <span className="hint" role={s.sendError() ? 'alert' : undefined}>
                {s.sendError() ??
                  s.lastTurn() ??
                  (current?.status === 'waiting'
                    ? 'Waiting for your answer above.'
                    : 'Enter sends, Shift+Enter adds a line.')}
              </span>
              <Button
                size="sm"
                type="submit"
                disabled={!!current || !s.prompt().trim() || !(chat?.cwd ?? s.workspace())}
              >
                Send
              </Button>
            </div>
          </form>
        </article>
      </div>
    </section>
  );
}
