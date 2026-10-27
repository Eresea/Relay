import { useEffect, type KeyboardEvent } from 'react';

import type { Command } from '@/core/command';
import { CommandRegistry } from '@/core/command-registry';
import { ModuleRegistry } from '@/core/modules';
import { hueFor, hueVar } from '@/core/entity-hue';
import type { NotificationRecord } from '@/core/events';
import { NotificationCenter } from '@/core/notification-center';
import { RECENT_COMMANDS_KEY, updateRecentCommandIds } from '@/core/recent-commands';
import {
  TauriBridge,
  codexThreadTitle,
  type CodexThreadSummary,
  type WorkspaceSummary,
} from '@/core/tauri';
import { inject } from '@/lib/inject';
import { computed, signal, useSignals } from '@/lib/signals';
import { cn, vars } from '@/lib/utils';
import { Icon } from '@/shared/icon';
import { keycaps } from '@/features/settings/shortcuts';
import { Kbd } from '@/shared/kbd';
import { loadChoices } from '@/features/agents/chat';

import {
  MODES,
  ago,
  buildSections,
  completion,
  folderName,
  type Mode,
  type OmniMatch,
  type OmniResult,
  type Sources,
} from './omnibar';
import './omnibar.css';

const WORKSPACE_REFRESH_MS = 5 * 60_000;
const THREAD_REFRESH_MS = 60_000;
const ASK_PROJECTS = 4;
const CODEX_TONE = hueVar(hueFor('codex'));
const CLAUDE_TONE = hueVar(hueFor('claude'));

const STATUS_LABEL = {
  running: 'Running',
  waiting: 'Needs you',
  blocked: 'Needs attention',
  done: 'Done',
} as const;

/**
 * Everything the Omnibar knows and does, independent of how it is drawn. One
 * per palette window: the window is created once and only shown and hidden
 * (see overlay.rs), so this lives for the life of the app.
 */
export class OmnibarState {
  private readonly registry = inject(CommandRegistry);
  private readonly modules = inject(ModuleRegistry);
  private readonly tauri = inject(TauriBridge);
  private readonly center = inject(NotificationCenter);
  private focusGeneration = 0;
  private paletteBlurred = false;
  /** The search field, once rendered. */
  private field: HTMLInputElement | null = null;
  readonly attachField = (element: HTMLInputElement | null): void => {
    this.field = element;
  };

  readonly mode = signal<Mode>('do');
  readonly query = signal('');
  readonly activeIndex = signal(0);
  readonly recentIds = signal<readonly string[]>([]);
  /** The attention shortcut as keycaps, as Settings has it bound. */
  readonly attentionKeys = signal<readonly string[]>(['Ctrl', 'Alt', 'Space']);
  readonly running = signal(false);
  readonly runError = signal(false);
  readonly loadingThreads = signal(false);
  readonly threadLoadFailed = signal(false);
  readonly threads = signal<readonly CodexThreadSummary[]>([]);
  readonly workspaces = signal<readonly WorkspaceSummary[]>([]);
  /** A project picked with "Ask Codex here"; otherwise the most recently changed one. */
  private readonly pinnedPath = signal<string | null>(null);
  private threadLoad: Promise<void> | null = null;
  private threadLoadAt = 0;
  private workspacesAt = 0;

  readonly context = computed(() => {
    const all = this.workspaces();
    return all.find((w) => w.path === this.pinnedPath()) ?? all[0] ?? null;
  });
  /** Workspaces with the one in context first, so it leads Ask and Run and wins ties. */
  private readonly ordered = computed(() => {
    const context = this.context();
    const rest = this.workspaces().filter((w) => w !== context);
    return context ? [context, ...rest] : rest;
  });
  readonly runningCount = computed(
    () => this.center.items().filter((n) => n.status === 'running').length,
  );
  readonly waitingCount = computed(
    () =>
      this.center.items().filter((n) => n.status === 'waiting' || n.status === 'blocked').length,
  );
  readonly placeholder = computed(() => MODES.find((m) => m.id === this.mode())?.placeholder ?? '');

  private readonly sources = computed<Sources>(() => ({
    Actions: this.registry
      .commands()
      .filter((c) => this.modules.commandEnabled(c.id))
      .map((c) => this.commandResult(c)),
    Ask: this.askResults(),
    Run: this.runResults(),
    Projects: this.ordered().map((w) => this.projectResult(w)),
    Agents: this.threads().map((t) => this.threadResult(t)),
    Activity: this.center.history().map((r) => this.activityResult(r)),
  }));

  readonly view = computed(() => {
    let index = 0;
    return buildSections(this.mode(), this.query(), this.sources(), this.recentIds()).map((s) => ({
      section: s.section,
      rows: s.matches.map((match) => ({ match, index: index++ })),
    }));
  });
  readonly flat = computed<readonly OmniMatch[]>(() =>
    this.view().flatMap((s) => s.rows.map((r) => r.match)),
  );
  readonly active = computed(() => this.flat()[this.activeIndex()]?.command);
  readonly ghost = computed(() => {
    const active = this.active();
    return active && this.mode() !== 'ask' ? completion(this.query(), active.title) : '';
  });

  /** Subscribes to window focus and loads stored state; returns the disposer. */
  start(): () => void {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void this.tauri
      .shortcutsList()
      .then((list) => {
        const attention = list.find((shortcut) => shortcut.action === 'attention');
        if (attention) this.attentionKeys.set(keycaps(attention.accelerator));
      })
      .catch(() => undefined);
    void this.tauri
      .onWindowFocusChanged((focused) => {
        if (focused) {
          if (this.threadLoadFailed()) {
            this.threadLoad = null;
            this.threadLoadFailed.set(false);
            if (this.wantsThreads()) void this.loadAgentThreads();
          }
          if (this.paletteBlurred) {
            this.focusGeneration++;
            this.paletteBlurred = false;
          }
          void this.loadWorkspaces();
          // Modules may have been turned on or off in the main window.
          void this.modules.load();
          this.field?.focus();
        } else {
          this.paletteBlurred = true;
        }
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });

    void this.tauri.getSetting<unknown>(RECENT_COMMANDS_KEY, []).then((stored) => {
      if (Array.isArray(stored)) {
        this.recentIds.set(stored.filter((id): id is string => typeof id === 'string'));
      }
    });
    void this.loadWorkspaces();
    void this.modules.load();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }

  onQuery(value: string): void {
    this.query.set(value);
    this.activeIndex.set(0);
    this.runError.set(false);
    if (this.wantsThreads()) void this.loadAgentThreads();
  }

  setMode(mode: Mode): void {
    this.mode.set(mode);
    this.activeIndex.set(0);
    this.runError.set(false);
    if (this.wantsThreads()) void this.loadAgentThreads();
    this.field?.focus();
  }

  onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.move(-1);
        break;
      case 'ArrowRight': {
        const input = this.field;
        const active = this.active();
        if (this.ghost() && active && input?.selectionStart === input?.value.length) {
          event.preventDefault();
          this.onQuery(active.title);
        }
        break;
      }
      case 'Enter':
        event.preventDefault();
        if (!this.active() && this.threadLoadFailed()) this.retryAgentThreads();
        else void this.runActive();
        break;
      case 'Tab': {
        event.preventDefault();
        const index = MODES.findIndex((m) => m.id === this.mode());
        const next = (index + (event.shiftKey ? -1 : 1) + MODES.length) % MODES.length;
        this.setMode(MODES[next].id);
        break;
      }
      case 'Escape':
        event.preventDefault();
        void this.dismiss();
        break;
      default:
        break;
    }
  }

  async run(command: Command | (() => unknown), recentId?: string): Promise<void> {
    if (this.running()) return;
    const focusGeneration = this.focusGeneration;
    const id = typeof command === 'function' ? recentId : command.id;
    if (id) {
      const recent = updateRecentCommandIds(this.recentIds(), id);
      this.recentIds.set(recent);
      void this.tauri.setSetting(RECENT_COMMANDS_KEY, recent);
    }
    this.running.set(true);
    this.runError.set(false);
    this.field?.focus();
    try {
      await (typeof command === 'function' ? command() : command.run());
    } catch {
      this.running.set(false);
      if (!this.paletteBlurred) this.runError.set(true);
      return;
    }
    this.running.set(false);
    if (focusGeneration !== this.focusGeneration) return;
    await this.dismiss();
  }

  retryAgentThreads(): void {
    if (this.loadingThreads()) return;
    this.threadLoad = null;
    this.threadLoadFailed.set(false);
    this.field?.focus();
    void this.loadAgentThreads();
  }

  private async runActive(): Promise<void> {
    const command = this.active();
    if (command) await this.run(command);
  }

  private wantsThreads(): boolean {
    return this.query().trim() !== '' || this.mode() === 'find' || this.mode() === 'ask';
  }

  private loadAgentThreads(): Promise<void> {
    if (!this.tauri.available) return Promise.resolve();
    if (this.threadLoad) {
      if (this.loadingThreads() || Date.now() - this.threadLoadAt < THREAD_REFRESH_MS) {
        return this.threadLoad;
      }
      this.threadLoad = null;
    }
    this.threadLoadFailed.set(false);
    this.threadLoadAt = Date.now();
    this.loadingThreads.set(true);
    this.threadLoad = this.tauri
      .codexListThreads()
      .then(({ threads }) => {
        const activeId = this.active()?.id;
        this.threads.set(threads);
        if (activeId) {
          const index = this.flat().findIndex((m) => m.command.id === activeId);
          if (index >= 0) this.activeIndex.set(index);
        }
      })
      .catch(() => {
        if (this.wantsThreads()) this.threadLoadFailed.set(true);
        else this.threadLoad = null;
      })
      .finally(() => this.loadingThreads.set(false));
    return this.threadLoad;
  }

  /** A shallow, bounded scan: cheap, but not free, so at most every few minutes. */
  private async loadWorkspaces(): Promise<void> {
    if (!this.tauri.available || Date.now() - this.workspacesAt < WORKSPACE_REFRESH_MS) return;
    this.workspacesAt = Date.now();
    try {
      this.workspaces.set(await this.tauri.scanWorkspaces());
    } catch {
      this.workspacesAt = 0;
    }
  }

  private async dismiss(): Promise<void> {
    if (this.running()) {
      this.focusGeneration++;
      this.paletteBlurred = true;
    }
    this.query.set('');
    this.mode.set('do');
    this.pinnedPath.set(null);
    this.activeIndex.set(0);
    this.runError.set(false);
    await this.tauri.dismissPalette();
  }

  private move(delta: number): void {
    if (this.running()) return;
    const count = this.flat().length;
    if (count === 0) return;
    this.activeIndex.update((i) => (i + delta + count) % count);
  }

  /* ---- results, one factory per source ---- */

  private commandResult(command: Command): OmniResult {
    return {
      ...command,
      section: 'Actions',
      verb: 'Run',
      facts: [
        ['Group', command.group],
        ...(command.shortcut ? [['Shortcut', command.shortcut.join(' ')] as const] : []),
      ],
    };
  }

  /** One row per agent and workspace, on the model and effort last picked in Agents. */
  private askResults(): readonly OmniResult[] {
    const prompt = this.query().trim();
    if (!prompt || this.mode() !== 'ask') return [];
    const on = (id: string) => this.modules.get(id)?.enabled !== false;
    return this.ordered()
      .slice(0, ASK_PROJECTS)
      .flatMap((w) => {
        const facts = [
          ['Project', w.name],
          ['Folder', w.path],
          ...(w.currentBranch ? [['Branch', w.currentBranch] as const] : []),
        ] as const;
        const codex: OmniResult = {
          id: `relay.ask.${w.path}`,
          title: prompt,
          section: 'Ask',
          group: 'Ask',
          icon: 'sparkles',
          tone: CODEX_TONE,
          sub: `Codex · ${w.name}`,
          verb: 'Ask',
          note: 'Starts a new Codex thread in the background. The answer arrives in the activity pill.',
          facts,
          run: async () => {
            await this.tauri.codexAsk(prompt, w.path, null, (await loadChoices(this.tauri)).codex);
          },
        };
        const claude: OmniResult = {
          id: `relay.ask.claude.${w.path}`,
          title: prompt,
          section: 'Ask',
          group: 'Ask',
          icon: 'bot',
          tone: CLAUDE_TONE,
          sub: `Claude · ${w.name}`,
          verb: 'Ask',
          note: 'Starts a new Claude Code session in the background. It reads freely; each edit or command waits for your Allow in the activity stack.',
          facts,
          run: async () => {
            await this.tauri.claudeAsk(
              prompt,
              w.path,
              null,
              (await loadChoices(this.tauri)).claude,
            );
          },
        };
        return on('agents') ? [codex, claude] : [];
      });
  }

  private runResults(): readonly OmniResult[] {
    return this.ordered().flatMap((w): OmniResult[] => {
      const tone = hueVar(hueFor(w.path));
      const scripts = (w.packageScripts ?? []).map((script): OmniResult => ({
        id: `relay.run.${w.path}.${script}`,
        title: `Run ${script} · ${w.name}`,
        section: 'Run',
        group: 'Run',
        icon: 'play',
        tone,
        keywords: ['npm', 'script', w.name],
        sub: `npm run ${script}`,
        verb: 'Start',
        note: 'Runs in the background. Progress and the result arrive in the activity pill.',
        facts: [
          ['Project', w.name],
          ['Command', `npm run ${script}`],
          ['Folder', w.path],
        ],
        run: () => this.tauri.projectScriptStart(w.path, script),
      }));
      return [
        ...scripts,
        {
          id: `relay.terminal.${w.path}`,
          title: `Open terminal · ${w.name}`,
          section: 'Run',
          group: 'Run',
          icon: 'terminal',
          tone,
          keywords: ['shell', 'console', 'terminal', w.name],
          sub: w.path,
          verb: 'Open',
          facts: [['Folder', w.path]],
          run: () => this.tauri.openTerminal(w.path),
        },
      ];
    });
  }

  private projectResult(w: WorkspaceSummary): OmniResult {
    const scripts = w.packageScripts?.length ?? 0;
    return {
      id: `relay.project.${w.path}`,
      title: w.name,
      section: 'Projects',
      group: 'Projects',
      icon: 'folder',
      tone: hueVar(hueFor(w.path)),
      keywords: [w.path, ...(w.githubRepo ? [w.githubRepo] : [])],
      sub: [w.currentBranch, w.githubRepo].filter(Boolean).join(' · ') || w.path,
      meta: w.modifiedAt ? ago(w.modifiedAt * 1000) : undefined,
      verb: 'Open folder',
      facts: [
        ...(w.currentBranch ? [['Branch', w.currentBranch] as const] : []),
        ['Folder', w.path],
        ...(w.githubRepo ? [['GitHub', w.githubRepo] as const] : []),
        ...(w.modifiedAt ? [['Changed', `${ago(w.modifiedAt * 1000)} ago`] as const] : []),
        ['Scripts', scripts === 0 ? 'None' : String(scripts)],
      ],
      more: [
        { label: 'Open terminal', run: () => this.run(() => this.tauri.openTerminal(w.path)) },
        {
          label: 'Ask Codex here',
          run: () => {
            this.pinnedPath.set(w.path);
            this.setMode('ask');
          },
        },
        {
          label: 'Fetch',
          run: () => this.run(() => this.tauri.runProjectAction(w.path, { id: 'gitFetch' })),
        },
      ],
      run: () => this.tauri.openPath(w.path),
    };
  }

  private threadResult(thread: CodexThreadSummary): OmniResult {
    const updated = (thread.recencyAt ?? thread.updatedAt ?? thread.createdAt) * 1000;
    const branch = thread.gitInfo?.branch;
    return {
      id: `relay.agents.thread.${thread.id}`,
      title: codexThreadTitle(thread),
      section: 'Agents',
      group: 'Codex',
      icon: 'file-text',
      tone: CODEX_TONE,
      keywords: ['thread', 'agent', 'codex', 'conversation', thread.cwd],
      sub: [folderName(thread.cwd), branch].filter(Boolean).join(' · '),
      meta: ago(updated),
      verb: 'Open',
      facts: [
        ['Folder', thread.cwd],
        ...(branch ? [['Branch', branch] as const] : []),
        ...(thread.model ? [['Model', thread.model] as const] : []),
        ['Updated', `${ago(updated)} ago`],
      ],
      more: [
        {
          label: 'Open in Codex',
          run: () =>
            this.run(() => this.tauri.openUrl(`codex://threads/${encodeURIComponent(thread.id)}`)),
        },
      ],
      run: () =>
        this.tauri.runCoreCommand({ id: 'open_agent_thread', args: { threadId: thread.id } }),
    };
  }

  private activityResult(record: NotificationRecord): OmniResult {
    const link = record.actions?.find((a) => a.id === 'open');
    const open = async () => {
      this.center.markRead(record.notificationId);
      await this.tauri.notificationsMarkRead([record.notificationId]);
      if (link) await this.tauri.openUrl(link.url);
      else await this.tauri.runCoreCommand({ id: 'open_main' });
    };
    return {
      id: `relay.activity.${record.notificationId}`,
      title: record.title,
      section: 'Activity',
      group: 'Activity',
      icon: record.icon ?? 'inbox',
      tone: hueVar(hueFor(record.hueSource)),
      keywords: record.detail ? [record.detail] : [],
      sub: record.detail,
      meta: ago(record.createdAt),
      verb: link ? link.label : 'Open Relay',
      facts: [
        ['Status', STATUS_LABEL[record.status]],
        ['When', `${ago(record.createdAt)} ago`],
        ...(record.read ? [] : [['Unread', 'Yes'] as const]),
      ],
      note: record.detail,
      run: open,
    };
  }
}

function tone(result: OmniResult): string | null {
  return result.tone ?? (result.hue ? hueVar(result.hue) : null);
}

function Tile({ result, large = false }: { result: OmniResult; large?: boolean }) {
  const color = tone(result);
  const size = large ? 16 : 14;
  return color ? (
    <span
      className={cn('u-entity-tile', large ? 'tile-lg' : 'tile')}
      style={vars({ '--entity-hue': color })}
    >
      <Icon name={result.icon ?? 'circle'} size={size} />
    </span>
  ) : (
    <span className={cn('plain', large ? 'tile-lg' : 'tile')}>
      <Icon name={result.icon ?? 'circle'} size={size} />
    </span>
  );
}

/** The matched letters of a title, underlined. */
function Title({ match }: { match: OmniMatch }) {
  const title = match.command.title;
  const parts: { text: string; matched: boolean }[] = [];
  let cursor = 0;
  for (const [start, end] of match.ranges) {
    if (start > cursor) parts.push({ text: title.slice(cursor, start), matched: false });
    parts.push({ text: title.slice(start, end), matched: true });
    cursor = end;
  }
  if (cursor < title.length) parts.push({ text: title.slice(cursor), matched: false });
  return (
    <span className="title">
      {parts.map((part, i) => (part.matched ? <mark key={i}>{part.text}</mark> : part.text))}
    </span>
  );
}

/**
 * The Omnibar: Relay's front door. One field, four modes — do, ask, find,
 * run — over every source the core can answer for: commands, local projects
 * and their scripts, Codex threads, and recent activity. The preview pane
 * says what Enter will do, and what it costs, before you press it.
 *
 * Anything slow (a Codex turn, a build) starts as a background job, so the
 * Omnibar can close at once and the attention pill reports the rest.
 */
export default function CommandPalette() {
  useSignals();
  const omni = inject(OmnibarState);
  useEffect(() => omni.start(), [omni]);

  // Keep the active row in view: arrowing past the visible rows without this
  // walks the selection off-screen with no visual sign it moved.
  const active = omni.active();
  useEffect(() => {
    if (active) document.getElementById(`cmd-${active.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const context = omni.context();
  const running = omni.running();
  const mode = omni.mode();

  return (
    <div className="omnibar u-glass u-chrome" onKeyDown={(event) => omni.onKeydown(event)}>
      <div className="context" aria-label="Context">
        {context && (
          <>
            <span className="chip" title="Project in context">
              <Icon name="folder" size={14} />
              {context.name}
            </span>
            {context.currentBranch && (
              <span className="chip mono">
                <Icon name="git-branch" size={14} />
                {context.currentBranch}
              </span>
            )}
          </>
        )}
        {omni.runningCount() > 0 && (
          <span className="chip">
            <span className="dot running" />
            {omni.runningCount()} running
          </span>
        )}
        {omni.waitingCount() > 0 && (
          <span className="needs">
            <span className="dot waiting" />
            {omni.waitingCount()} need you
          </span>
        )}
      </div>

      <div className="field">
        <Icon name="search" size={20} />
        <div className="input">
          <span className="ghost" aria-hidden="true">
            <span className="typed">{omni.query()}</span>
            {omni.ghost()}
          </span>
          <input
            ref={omni.attachField}
            type="text"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            placeholder={omni.placeholder()}
            aria-label="Search commands"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={active ? `cmd-${active.id}` : undefined}
            readOnly={running}
            value={omni.query()}
            onChange={(event) => omni.onQuery(event.target.value)}
          />
        </div>
        <div className="modes" role="radiogroup" aria-label="Mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={cn('mode', mode === m.id && 'on')}
              role="radio"
              tabIndex={-1}
              aria-checked={mode === m.id}
              onClick={() => omni.setMode(m.id)}
            >
              <Icon name={m.icon} size={14} />
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="body">
        <div
          className="results"
          id="palette-results"
          role="listbox"
          aria-label="Results"
          aria-busy={running || omni.loadingThreads()}
        >
          {omni.view().map((group) => (
            <div key={group.section} role="presentation">
              <p className="u-caption section">{group.section}</p>
              {group.rows.map(({ match, index }) => {
                const result = match.command;
                const isActive = index === omni.activeIndex();
                return (
                  <button
                    key={result.id}
                    id={`cmd-${result.id}`}
                    type="button"
                    className={cn('row', isActive && 'is-active')}
                    role="option"
                    tabIndex={-1}
                    aria-label={result.title}
                    aria-selected={isActive}
                    disabled={running}
                    onClick={() => void omni.run(result)}
                    onMouseMove={() => omni.activeIndex.set(index)}
                  >
                    <Tile result={result} />
                    <span className="label">
                      <Title match={match} />
                      {result.sub && <span className="sub">{result.sub}</span>}
                    </span>
                    {result.meta && <span className="meta">{result.meta}</span>}
                    {result.shortcut && <Kbd keys={result.shortcut} />}
                  </button>
                );
              })}
            </div>
          ))}

          {omni.flat().length === 0 && (
            <div className="empty" role="status" aria-live="polite">
              {omni.loadingThreads() ? (
                <p className="title">Searching Codex threads…</p>
              ) : omni.threadLoadFailed() ? (
                <>
                  <p className="title">Could not load Codex threads</p>
                  <button type="button" className="retry" onClick={() => omni.retryAgentThreads()}>
                    Retry
                  </button>
                </>
              ) : mode === 'ask' ? (
                <>
                  <p className="title">Type a question</p>
                  <p className="body">
                    Codex answers in {context?.name ?? 'a project'}, in the background.
                  </p>
                </>
              ) : (
                <>
                  <p className="title">Nothing matches</p>
                  <p className="body">Try a shorter word, or press Tab for another mode.</p>
                </>
              )}
            </div>
          )}
        </div>

        <aside className="preview" aria-live="polite">
          {active && (
            <>
              <div className="preview-head">
                <Tile result={active} large />
                <div className="preview-title">
                  <p className="name">{active.title}</p>
                  {active.sub && <p className="sub">{active.sub}</p>}
                </div>
              </div>

              {active.note && <p className="note">{active.note}</p>}

              {active.facts && active.facts.length > 0 && (
                <dl className="facts">
                  {active.facts.map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              <div className="acts">
                <button
                  type="button"
                  className="act primary"
                  disabled={running}
                  onClick={() => void omni.run(active)}
                >
                  {active.verb ?? 'Open'}
                  <Kbd keys={['Enter']} />
                </button>
                {(active.more ?? []).map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className="act"
                    disabled={running}
                    onClick={() => void action.run()}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>

      <div className={cn('foot', omni.runError() && 'error')} aria-live="polite">
        {running ? (
          <span>Working…</span>
        ) : omni.runError() ? (
          <>
            <span>Could not complete that action.</span>
            <span>Retry</span>
            <Kbd keys={['Enter']} />
          </>
        ) : (
          <>
            <span>Move</span>
            <Kbd keys={['↑', '↓']} />
            <span>Open</span>
            <Kbd keys={['Enter']} />
            {omni.ghost() && (
              <>
                <span>Complete</span>
                <Kbd keys={['→']} />
              </>
            )}
            <span>Mode</span>
            <Kbd keys={['Tab']} />
          </>
        )}
        <span className="spacer" />
        <span>Activity</span>
        <Kbd keys={omni.attentionKeys()} />
        <span>Close</span>
        <Kbd keys={['Esc']} />
      </div>
    </div>
  );
}
