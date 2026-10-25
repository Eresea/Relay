import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
  viewChildren,
  type ElementRef,
} from '@angular/core';

import type { Command } from '@core/command';
import { CommandRegistry } from '@core/command-registry';
import { hueFor, hueVar } from '@core/entity-hue';
import type { NotificationRecord } from '@core/events';
import { NotificationCenter } from '@core/notification-center';
import { RECENT_COMMANDS_KEY, updateRecentCommandIds } from '@core/recent-commands';
import {
  TauriBridge,
  codexThreadTitle,
  type CodexThreadSummary,
  type WorkspaceSummary,
} from '@core/tauri';
import { Icon } from '@shared/icon';
import { Kbd } from '@shared/kbd';

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

interface TitlePart {
  readonly text: string;
  readonly matched: boolean;
}

const WORKSPACE_REFRESH_MS = 5 * 60_000;
const THREAD_REFRESH_MS = 60_000;
const ASK_PROJECTS = 4;
const CODEX_TONE = hueVar(hueFor('codex'));

const STATUS_LABEL = {
  running: 'Running',
  waiting: 'Needs you',
  blocked: 'Needs attention',
  done: 'Done',
} as const;

/**
 * The Omnibar: Relay's front door. One field, four modes — do, ask, find,
 * run — over every source the core can answer for: commands, local projects
 * and their scripts, Codex threads, and recent activity. The preview pane
 * says what Enter will do, and what it costs, before you press it.
 *
 * Anything slow (a Codex turn, a build) starts as a background job, so the
 * Omnibar can close at once and the attention pill reports the rest.
 */
@Component({
  selector: 'rl-command-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Kbd],
  templateUrl: './command-palette.html',
  styleUrl: './command-palette.css',
  host: {
    class: 'u-glass u-chrome',
    '(keydown)': 'onKeydown($event)',
  },
})
export class CommandPalette {
  private readonly registry = inject(CommandRegistry);
  private readonly tauri = inject(TauriBridge);
  private readonly center = inject(NotificationCenter);
  private focusGeneration = 0;
  private paletteBlurred = false;

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  /** DOM order matches `flat()`, since both come from `view()`. */
  private readonly rows = viewChildren<ElementRef<HTMLElement>>('row');

  protected readonly modes = MODES;
  protected readonly mode = signal<Mode>('do');
  protected readonly query = signal('');
  protected readonly activeIndex = signal(0);
  protected readonly recentIds = signal<readonly string[]>([]);
  protected readonly running = signal(false);
  protected readonly runError = signal(false);
  protected readonly loadingThreads = signal(false);
  protected readonly threadLoadFailed = signal(false);
  private readonly threads = signal<readonly CodexThreadSummary[]>([]);
  private readonly workspaces = signal<readonly WorkspaceSummary[]>([]);
  /** A project picked with "Ask Codex here"; otherwise the most recently changed one. */
  private readonly pinnedPath = signal<string | null>(null);
  private threadLoad: Promise<void> | null = null;
  private threadLoadAt = 0;
  private workspacesAt = 0;

  protected readonly context = computed(() => {
    const all = this.workspaces();
    return all.find((w) => w.path === this.pinnedPath()) ?? all[0] ?? null;
  });
  /** Workspaces with the one in context first, so it leads Ask and Run and wins ties. */
  private readonly ordered = computed(() => {
    const context = this.context();
    const rest = this.workspaces().filter((w) => w !== context);
    return context ? [context, ...rest] : rest;
  });
  protected readonly runningCount = computed(
    () => this.center.items().filter((n) => n.status === 'running').length,
  );
  protected readonly waitingCount = computed(
    () =>
      this.center.items().filter((n) => n.status === 'waiting' || n.status === 'blocked').length,
  );
  protected readonly placeholder = computed(
    () => MODES.find((m) => m.id === this.mode())?.placeholder ?? '',
  );

  private readonly sources = computed<Sources>(() => ({
    Actions: this.registry.commands().map((c) => this.commandResult(c)),
    Ask: this.askResults(),
    Run: this.runResults(),
    Projects: this.ordered().map((w) => this.projectResult(w)),
    Agents: this.threads().map((t) => this.threadResult(t)),
    Activity: this.center.history().map((r) => this.activityResult(r)),
  }));

  protected readonly view = computed(() => {
    let index = 0;
    return buildSections(this.mode(), this.query(), this.sources(), this.recentIds()).map((s) => ({
      section: s.section,
      rows: s.matches.map((match) => ({ match, index: index++ })),
    }));
  });
  protected readonly flat = computed<readonly OmniMatch[]>(() =>
    this.view().flatMap((s) => s.rows.map((r) => r.match)),
  );
  protected readonly active = computed(() => this.flat()[this.activeIndex()]?.command);
  protected readonly ghost = computed(() => {
    const active = this.active();
    return active && this.mode() !== 'ask' ? completion(this.query(), active.title) : '';
  });

  constructor() {
    // Runs after the DOM reflects the current activeIndex, so the row being
    // scrolled to exists. Arrowing past the visible rows without this walks
    // the selection off-screen with no visual sign it moved.
    afterRenderEffect(() => {
      this.rows()[this.activeIndex()]?.nativeElement.scrollIntoView({ block: 'nearest' });
    });

    // The palette window is created once and only shown and hidden (see
    // overlay.rs), so the OS focus event is the only sign it is back.
    const destroyRef = inject(DestroyRef);
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
          this.field().nativeElement.focus();
        } else {
          this.paletteBlurred = true;
        }
      })
      .then((unlisten) => destroyRef.onDestroy(unlisten));

    void this.tauri.getSetting<unknown>(RECENT_COMMANDS_KEY, []).then((stored) => {
      if (Array.isArray(stored)) {
        this.recentIds.set(stored.filter((id): id is string => typeof id === 'string'));
      }
    });
    void this.loadWorkspaces();
  }

  protected onQuery(value: string): void {
    this.query.set(value);
    this.activeIndex.set(0);
    this.runError.set(false);
    if (this.wantsThreads()) void this.loadAgentThreads();
  }

  protected setMode(mode: Mode): void {
    this.mode.set(mode);
    this.activeIndex.set(0);
    this.runError.set(false);
    if (this.wantsThreads()) void this.loadAgentThreads();
    this.field().nativeElement.focus();
  }

  protected tone(result: OmniResult): string | null {
    return result.tone ?? (result.hue ? hueVar(result.hue) : null);
  }

  protected titleParts(match: OmniMatch): readonly TitlePart[] {
    const title = match.command.title;
    const parts: TitlePart[] = [];
    let cursor = 0;
    for (const [start, end] of match.ranges) {
      if (start > cursor) parts.push({ text: title.slice(cursor, start), matched: false });
      parts.push({ text: title.slice(start, end), matched: true });
      cursor = end;
    }
    if (cursor < title.length) parts.push({ text: title.slice(cursor), matched: false });
    return parts;
  }

  protected onKeydown(event: KeyboardEvent): void {
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
        const input = this.field().nativeElement;
        const atEnd = input.selectionStart === input.value.length;
        const active = this.active();
        if (this.ghost() && atEnd && active) {
          event.preventDefault();
          input.value = active.title;
          this.onQuery(input.value);
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

  protected async run(command: Command | (() => unknown), recentId?: string): Promise<void> {
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
    this.field().nativeElement.focus();
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

  protected retryAgentThreads(): void {
    if (this.loadingThreads()) return;
    this.threadLoad = null;
    this.threadLoadFailed.set(false);
    this.field().nativeElement.focus();
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
    this.field().nativeElement.value = '';
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

  private askResults(): readonly OmniResult[] {
    const prompt = this.query().trim();
    if (!prompt || this.mode() !== 'ask') return [];
    return this.ordered()
      .slice(0, ASK_PROJECTS)
      .map((w) => ({
        id: `relay.ask.${w.path}`,
        title: prompt,
        section: 'Ask',
        group: 'Ask',
        icon: 'sparkles',
        tone: CODEX_TONE,
        sub: `Codex · ${w.name}`,
        verb: 'Ask',
        note: 'Starts a new Codex thread in the background. The answer arrives in the activity pill.',
        facts: [
          ['Project', w.name],
          ['Folder', w.path],
          ...(w.currentBranch ? [['Branch', w.currentBranch] as const] : []),
        ],
        run: () => this.tauri.codexAsk(prompt, w.path),
      }));
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
