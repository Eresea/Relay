import { Fragment, lazy, Suspense, useEffect, useState } from 'react';

import { moduleHueVar } from '@/core/entity-hue';
import { ModuleRegistry } from '@/core/modules';
import { NexusAccount } from '@/core/nexus-account';
import { NotificationCenter } from '@/core/notification-center';
import { TauriBridge } from '@/core/tauri';
import { ThemeService } from '@/core/theme';
import Today from '@/features/today/today-view';
import { keycaps } from '@/features/settings/shortcuts';
import { SOURCES, sourceOf } from '@/features/today/today';
import { UpdateStatusBar } from '@/features/updates/update-status-bar';
import { inject } from '@/lib/inject';
import { computed, signal, useSignals } from '@/lib/signals';
import { cn, vars } from '@/lib/utils';
import { AppPopover, PopoverClose, PopoverContent, PopoverTrigger } from '@/shared/app-popover';
import { BackgroundTaskIndicator } from '@/shared/background-task-indicator';
import { Icon } from '@/shared/icon';
import { Kbd } from '@/shared/kbd';

import type { ChatRequest } from '@/features/agents/agents';

import { Inspector } from './inspector';
import './home.css';

const Settings = lazy(() => import('@/features/settings/settings'));
const Agents = lazy(() => import('@/features/agents/agents'));
const Linear = lazy(() => import('@/features/linear/linear'));
const Vault = lazy(() => import('@/features/vault/vault'));
const Runtime = lazy(() => import('@/features/runtime/runtime'));
const Terminal = lazy(() => import('@/features/terminal/terminal'));
const WebAppView = lazy(() => import('@/features/webapps/web-app-view'));
const Projects = lazy(() => import('@/features/projects/projects'));
const Modules = lazy(() => import('@/features/modules/modules'));

const INSPECTOR_SETTING_KEY = 'deck.inspector';
const SPLIT_SETTING_KEY = 'deck.split';
/** Neither pane of a split gets narrower than this share of the width. */
const MIN_SPLIT = 0.2;
/** Module ids of pinned web apps; mirrors webapps::MODULE_PREFIX. */
const WEB = 'web-';

/** A Deck view is a module's surface, named by the module's id. */
type HomeView = string;
type SettingsTab = 'general' | 'github' | 'linear';
interface LinearProjectRequest {
  readonly organizationId: string;
  readonly projectId: string;
}

/** The main window's navigation state. One per main window. */
export class HomeState {
  readonly account = inject(NexusAccount);
  readonly theme = inject(ThemeService);
  readonly center = inject(NotificationCenter);
  readonly modules = inject(ModuleRegistry);
  private readonly tauri = inject(TauriBridge);

  readonly accountName = computed(
    () => this.account.status().displayName || this.account.status().email || 'Nexus account',
  );
  readonly avatar = computed(() =>
    this.account.status().connected ? this.accountName().trim().charAt(0).toLocaleUpperCase() : 'N',
  );
  /** Open tabs, left to right. Today is pinned first and never closes. */
  readonly tabs = signal<readonly HomeView[]>(['today']);
  /** The focused pane's view; tab keys, opening and closing act on it. */
  readonly view = signal<HomeView>('today');
  /** The other pane's view while the Deck is split, else null. */
  readonly other = signal<HomeView | null>(null);
  /** Whether the focused pane is the left one of a split. */
  readonly focusedLeft = signal(true);
  /** The left pane's share of the width while split. */
  readonly splitRatio = signal(0.5);
  /** A conversation another surface asked the Agents tab to open. */
  readonly requestedChat = signal<ChatRequest>(null);
  /** Stable, so the Agents tab's effect does not re-run on every render. */
  readonly chatHandled = () => this.requestedChat.set(null);
  readonly linearProjectRequest = signal<LinearProjectRequest | null>(null);
  readonly inspector = signal(true);
  readonly settingsTab = signal<SettingsTab>('general');
  readonly maximized = signal(false);

  /** Modules with a surface on the rail's top, in registry order. */
  readonly rail = computed(() => this.modules.enabled().filter((m) => m.surface?.rail));
  /** Open tabs whose module is on: turning a module off closes its tab. */
  readonly openTabs = computed(() =>
    this.tabs().filter((id) => id === 'today' || this.modules.isEnabled(id)),
  );
  readonly current = computed(() => (this.modules.isEnabled(this.view()) ? this.view() : 'today'));
  /** The other pane's view, gone once its tab or module is. */
  readonly otherPane = computed(() => {
    const other = this.other();
    return other && other !== this.current() && this.openTabs().includes(other) ? other : null;
  });
  /** The views on screen, left to right: one, or two when split. */
  readonly panes = computed<readonly HomeView[]>(() => {
    const other = this.otherPane();
    if (!other) return [this.current()];
    return this.focusedLeft() ? [this.current(), other] : [other, this.current()];
  });

  readonly running = computed(() => this.center.items().filter((n) => n.status === 'running'));
  readonly needsYou = computed(() =>
    this.center.items().filter((n) => n.status === 'waiting' || n.status === 'blocked'),
  );
  /** Modules with something waiting on you, so their tab can say so. */
  readonly needsYouIn = computed(
    () => new Set(this.needsYou().map((n) => SOURCES[sourceOf(n.hueSource)].module)),
  );
  /** The Omnibar's shortcut as keycaps, as Settings has it bound. */
  readonly paletteKeys = signal<readonly string[]>(['Ctrl', 'Space']);

  /** Window and event listeners; returns their disposer. */
  start(): () => void {
    void this.modules.load();
    void this.tauri
      .shortcutsList()
      .then((list) => {
        const palette = list.find((shortcut) => shortcut.action === 'palette');
        if (palette) this.paletteKeys.set(keycaps(palette.accelerator));
      })
      .catch(() => undefined);
    void this.tauri
      .getSetting<boolean>(INSPECTOR_SETTING_KEY, this.inspector())
      .then((stored) => this.inspector.set(stored));
    void this.tauri
      .getSetting<number>(SPLIT_SETTING_KEY, this.splitRatio())
      .then((stored) => this.resizeSplit(stored));
    void this.tauri.isWindowMaximized().then((value) => this.maximized.set(value));

    const unlisteners: Promise<() => void>[] = [
      this.tauri.onWindowResized(
        () => void this.tauri.isWindowMaximized().then((value) => this.maximized.set(value)),
      ),
      // The palette that dispatched "Open settings" and this window are separate
      // webviews with no shared JS state, so the core tells this one to switch
      // views over the event channel.
      this.tauri.onEvent((event) => {
        if (event.type === 'openSettingsRequested') this.openSettings();
        if (event.type === 'openVaultRequested') this.open('vault');
        if (event.type === 'openRuntimeRequested') this.open('runtime');
        if (event.type === 'openTerminalRequested') this.open('terminal');
        if (event.type === 'openAgentsRequested') this.open('agents');
        if (event.type === 'openAgentThreadRequested') this.openThread(event.threadId);
        if (event.type === 'openClaudeRequested') {
          if (event.sessionId) this.requestedChat.set({ agent: 'claude', id: event.sessionId });
          this.open('agents');
        }
        if (event.type === 'openGithubRequested') this.openSettings('github');
        if (event.type === 'openLinearRequested') this.open('linear');
      }),
    ];
    const keys = (event: KeyboardEvent) => this.onKey(event);
    window.addEventListener('keydown', keys);
    return () => {
      window.removeEventListener('keydown', keys);
      unlisteners.forEach((p) => void p.then((stop) => stop()));
    };
  }

  /** Focuses a view's tab, opening one after the current tab if it has none. */
  open(view: HomeView): void {
    if (!this.modules.get(view)?.surface || !this.modules.isEnabled(view)) return;
    this.tabs.update((tabs) => {
      if (tabs.includes(view)) return tabs;
      const at = tabs.indexOf(this.current()) + 1;
      return [...tabs.slice(0, at), view, ...tabs.slice(at)];
    });
    this.select(view);
  }

  /** Shows an open tab: focuses its pane if it is on screen, else puts it in the focused pane. */
  select(view: HomeView): void {
    if (view === this.otherPane()) {
      this.other.set(this.current());
      this.focusedLeft.update((left) => !left);
    }
    this.view.set(view);
  }

  /** Focuses the pane at `index` (0 is the left one). */
  focusPane(index: number): void {
    const view = this.panes()[index];
    if (view && view !== this.current()) this.select(view);
  }

  /**
   * Shows `view` in a right-hand pane and focuses it. The left pane keeps
   * what it showed; splitting the focused tab itself puts its neighbour there.
   */
  split(view: HomeView): void {
    const tabs = this.openTabs();
    if (!tabs.includes(view)) return;
    const [first, second] = this.panes();
    const left =
      first !== view
        ? first
        : (second ?? tabs[tabs.indexOf(view) - 1] ?? tabs[tabs.indexOf(view) + 1]);
    if (!left) return;
    this.other.set(left);
    this.focusedLeft.set(false);
    this.view.set(view);
  }

  unsplit(): void {
    this.other.set(null);
    this.focusedLeft.set(true);
  }

  toggleSplit(): void {
    if (this.otherPane()) this.unsplit();
    else this.split(this.current());
  }

  resizeSplit(ratio: number): void {
    if (Number.isFinite(ratio))
      this.splitRatio.set(Math.min(1 - MIN_SPLIT, Math.max(MIN_SPLIT, ratio)));
  }

  saveSplit(): void {
    void this.tauri.setSetting(SPLIT_SETTING_KEY, this.splitRatio());
  }

  /** Moves tab `view` to where `target` is; Today stays pinned first. */
  move(view: HomeView, target: HomeView): void {
    if (view === target || view === 'today' || target === 'today') return;
    this.tabs.update((tabs) => {
      const rest = tabs.filter((tab) => tab !== view);
      const at = rest.indexOf(target) + (tabs.indexOf(view) < tabs.indexOf(target) ? 1 : 0);
      return [...rest.slice(0, at), view, ...rest.slice(at)];
    });
  }

  /** The Omnibar: search, run or ask, from inside the window too. */
  openPalette(): void {
    void this.tauri.togglePalette();
  }

  close(view: HomeView): void {
    if (view === 'today') return;
    // A pinned app's webview is destroyed with its tab, so it costs no memory.
    if (this.modules.get(view)?.kind === 'web')
      void this.tauri.webAppsClose(view.slice(WEB.length));
    const tabs = this.openTabs();
    const at = tabs.indexOf(view);
    const other = this.otherPane();
    this.tabs.update((all) => all.filter((tab) => tab !== view));
    // Closing either half of a split leaves the other half the whole Deck.
    if (this.current() === view) this.view.set(other ?? tabs[at - 1] ?? 'today');
    if (other && (view === other || this.current() === other)) this.unsplit();
  }

  /**
   * Browser tab keys: Ctrl+W closes the tab, Ctrl+Tab and Ctrl+Shift+Tab
   * cycle. Ctrl+\ splits the Deck or joins it again, as in an editor.
   */
  private onKey(event: KeyboardEvent): void {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key.toLowerCase() === 'w' && !event.shiftKey) {
      event.preventDefault();
      this.close(this.current());
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const tabs = this.openTabs();
      const step = event.shiftKey ? -1 : 1;
      this.select(tabs[(tabs.indexOf(this.current()) + step + tabs.length) % tabs.length]);
    } else if (event.key === '\\' || event.code === 'Backslash') {
      event.preventDefault();
      this.toggleSplit();
    }
  }

  openThread(threadId: string): void {
    this.requestedChat.set({ agent: 'codex', id: threadId });
    this.open('agents');
  }

  openLinearProject(request: LinearProjectRequest): void {
    this.linearProjectRequest.set(request);
    this.open('linear');
  }

  handleLinearProjectRequest(request: LinearProjectRequest): void {
    const current = this.linearProjectRequest();
    if (
      current?.organizationId === request.organizationId &&
      current.projectId === request.projectId
    ) {
      this.linearProjectRequest.set(null);
    }
  }

  openSettings(tab: SettingsTab = 'general'): void {
    this.settingsTab.set(tab);
    this.open('settings');
  }

  toggleInspector(): void {
    const shown = !this.inspector();
    this.inspector.set(shown);
    void this.tauri.setSetting(INSPECTOR_SETTING_KEY, shown);
  }

  minimize(): void {
    void this.tauri.minimizeWindow();
  }

  toggleMaximize(): void {
    void this.tauri.toggleMaximizeWindow();
  }

  closeWindow(): void {
    void this.tauri.closeWindow();
  }
}

/**
 * The Deck: the main window. `decorations: false` in tauri.conf.json means the
 * OS draws no title bar, so everything here — tabs, window buttons, rail — is
 * drawn by Relay and must behave like a native shell: a titlebar that never
 * scrolls away, and window buttons flush with the window's own edges.
 */
export default function Home() {
  useSignals();
  const s = inject(HomeState);
  useEffect(() => s.start(), [s]);
  const [dragging, setDragging] = useState<HomeView | null>(null);

  const view = s.current();
  const panes = s.panes();
  const split = panes.length > 1;
  // Today is pinned before the registry has loaded, so it needs a face of its own.
  const surface = (id: string) =>
    s.modules.get(id)?.surface ??
    (id === 'today' ? { label: 'Today', icon: 'house' } : { label: id, icon: 'circle' });
  const hue = (id: string) => moduleHueVar(s.modules.get(id)?.hue ?? 'relay');
  const status = s.account.status();
  const running = s.running().length;
  const needsYou = s.needsYou().length;

  return (
    <div className="home">
      <header className="titlebar u-chrome" data-tauri-drag-region="">
        <span className="wordmark" data-tauri-drag-region="">
          Relay
        </span>
        <button
          type="button"
          className="search"
          onClick={() => s.openPalette()}
          aria-label="Search, run or ask"
        >
          <Icon name="search" size={14} />
          <span className="search-label">Search, run or ask</span>
          <Kbd keys={s.paletteKeys()} />
        </button>
        <div
          className="tabs"
          role="tablist"
          aria-label="Open views"
          data-tauri-drag-region=""
          onWheel={(event) => {
            // A vertical wheel scrolls the strip sideways, as in a browser.
            event.currentTarget.scrollLeft += event.deltaY;
          }}
        >
          {s.openTabs().map((tab) => (
            <div
              key={tab}
              className={cn(
                'tab',
                view === tab && 'active',
                s.otherPane() === tab && 'shown',
                dragging === tab && 'dragging',
              )}
              draggable={tab !== 'today'}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                setDragging(tab);
              }}
              onDragOver={(event) => {
                if (dragging && dragging !== tab && tab !== 'today') event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging) s.move(dragging, tab);
              }}
              onDragEnd={() => setDragging(null)}
              // Middle click closes a tab, as in a browser; the mousedown
              // guard stops the webview starting autoscroll first.
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button === 1) s.close(tab);
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={view === tab}
                className="tab-open"
                onClick={() => s.select(tab)}
              >
                {tab === 'today' ? (
                  <Icon name={surface(tab).icon} size={14} />
                ) : (
                  <span
                    className="u-entity-tile tab-tile"
                    style={vars({ '--entity-hue': hue(tab) })}
                  >
                    <Icon name={surface(tab).icon} size={14} />
                  </span>
                )}
                <span className="tab-label">{surface(tab).label}</span>
                {(tab === 'today' ? needsYou > 0 : s.needsYouIn().has(tab)) && (
                  <span className="tab-dot" aria-label="needs you" />
                )}
              </button>
              {tab !== 'today' && (
                <button
                  type="button"
                  className="tab-close"
                  aria-label={`Close ${surface(tab).label}`}
                  onClick={() => s.close(tab)}
                >
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="tab-new"
            aria-label="Open something new"
            title="Open something new"
            onClick={() => s.openPalette()}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        <button
          type="button"
          className="activity"
          hidden={running + needsYou === 0}
          onClick={() => s.open('today')}
          aria-label={`${needsYou} need you, ${running} running. Open Today`}
        >
          {running > 0 && (
            <span className="activity-part">
              <span className="dot" data-status="running" />
              {running} running
            </span>
          )}
          {needsYou > 0 && (
            <span className="activity-part">
              <span className="dot" data-status="waiting" />
              {needsYou} need{needsYou === 1 ? 's' : ''} you
            </span>
          )}
        </button>
        <div className="window-controls">
          <button
            type="button"
            className={cn('window-btn', split && 'on')}
            onClick={() => s.toggleSplit()}
            disabled={!split && s.openTabs().length < 2}
            aria-label={split ? 'Join panes' : 'Split view'}
            aria-pressed={split}
            title={split ? 'Join panes (Ctrl+\\)' : 'Split view (Ctrl+\\)'}
          >
            <Icon name="columns-2" size={14} />
          </button>
          <button
            type="button"
            className={cn('window-btn', s.inspector() && 'on')}
            onClick={() => s.toggleInspector()}
            aria-label={s.inspector() ? 'Hide inspector' : 'Show inspector'}
            aria-pressed={s.inspector()}
          >
            <Icon name="panel-right" size={14} />
          </button>
          <button
            type="button"
            className="window-btn"
            onClick={() => s.theme.toggle()}
            aria-label="Toggle theme"
          >
            <Icon name={s.theme.theme() === 'dark' ? 'sun' : 'moon'} size={14} />
          </button>
          <button
            type="button"
            className="window-btn"
            onClick={() => s.minimize()}
            aria-label="Minimize"
          >
            <Icon name="minus" size={14} />
          </button>
          <button
            type="button"
            className="window-btn"
            onClick={() => s.toggleMaximize()}
            aria-label={s.maximized() ? 'Restore' : 'Maximize'}
          >
            <Icon name={s.maximized() ? 'copy' : 'square'} size={14} />
          </button>
          <button
            type="button"
            className="window-btn close"
            onClick={() => s.closeWindow()}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      </header>

      <div className="body">
        <nav className="rail u-chrome" aria-label="Rail">
          <div className="rail-top">
            {s.rail().map((module) => (
              <button
                key={module.id}
                type="button"
                className={cn(
                  'rail-item',
                  view === module.id && 'active',
                  s.openTabs().includes(module.id) && 'open',
                )}
                onClick={() => s.open(module.id)}
                aria-label={surface(module.id).label}
                data-label={surface(module.id).label}
              >
                <Icon name={surface(module.id).icon} size={16} />
                {module.id === 'today' && needsYou > 0 && <span className="badge" />}
              </button>
            ))}
          </div>

          <div className="rail-bottom">
            <button
              type="button"
              className={cn('rail-item', view === 'modules' && 'active')}
              onClick={() => s.open('modules')}
              aria-label="Modules"
              data-label="Modules"
            >
              <Icon name="blocks" size={16} />
            </button>
            <button
              type="button"
              className={cn('rail-item', view === 'settings' && 'active')}
              onClick={() => s.openSettings()}
              aria-label="Settings"
              data-label="Settings"
            >
              <Icon name="settings" size={16} />
            </button>
            <AppPopover>
              <PopoverTrigger>
                <button
                  type="button"
                  className="rail-item account-trigger"
                  aria-label="Nexus account"
                  title={status.connected ? s.accountName() : 'Sign in with Nexus'}
                >
                  <span className="avatar" aria-hidden="true">
                    {s.avatar()}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent
                role="menu"
                side="right"
                align="end"
                className="account-menu"
                aria-label="Nexus account"
              >
                <p className="u-caption">Nexus account</p>
                {status.connected ? (
                  <>
                    <p className="account-name">{s.accountName()}</p>
                    {status.email && status.displayName && (
                      <p className="account-email">{status.email}</p>
                    )}
                    <PopoverClose asChild>
                      <button type="button" role="menuitem" onClick={() => s.open('account')}>
                        Account details
                      </button>
                    </PopoverClose>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={s.account.busy()}
                      onClick={() => void s.account.logout()}
                    >
                      Sign out
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={s.account.busy()}
                      onClick={() => void s.account.logout(true)}
                    >
                      Sign out everywhere
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!s.account.available}
                      onClick={() => void s.account.login()}
                    >
                      Sign in with Nexus
                    </button>
                    {s.account.waiting() && <p className="account-email">Waiting for sign-in…</p>}
                  </>
                )}
                {s.account.error() && (
                  <p className="account-error" role="alert">
                    {s.account.error()}
                  </p>
                )}
              </PopoverContent>
            </AppPopover>
          </div>
        </nav>

        <div
          className={cn('panes', split && 'split')}
          style={vars({ '--split': `${s.splitRatio() * 100}%` })}
        >
          {panes.map((pane, index) => (
            <Fragment key={pane}>
              {index === 1 && <SplitDivider s={s} />}
              <main
                className={cn('content', split && pane === view && 'focused')}
                role="tabpanel"
                aria-label={surface(pane).label}
                onPointerDownCapture={() => s.focusPane(index)}
              >
                <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
                  <DeckView s={s} view={pane} />
                </Suspense>
              </main>
            </Fragment>
          ))}
          {dragging && (
            // Dropping a dragged tab on the right half opens it beside the
            // focused view, as dragging an editor tab does in an IDE.
            <div
              className="split-drop"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                s.split(dragging);
                setDragging(null);
              }}
            >
              <Icon name="columns-2" size={16} />
              Open on the right
            </div>
          )}
        </div>

        {s.inspector() && <Inspector onOpenThread={(id) => s.openThread(id)} />}
      </div>

      <footer className="statusbar u-chrome">
        <span className="status-part">
          <span className="dot" data-status={status.connected ? 'done' : 'idle'} />
          {status.connected ? `Nexus · ${s.accountName()}` : 'Nexus · signed out'}
        </span>
        <BackgroundTaskIndicator />
        <span className="status-end">
          <UpdateStatusBar />
          <span className="status-part">
            <Kbd keys={['Ctrl', 'Alt', 'Space']} />
            Activity
          </span>
        </span>
      </footer>
    </div>
  );
}

/** A module's surface, in whichever pane shows it. */
function DeckView({ s, view }: { s: HomeState; view: HomeView }) {
  return view === 'today' ? (
    <Today />
  ) : view === 'modules' ? (
    <Modules onOpen={(id) => s.open(id)} />
  ) : view === 'account' ? (
    <AccountPage s={s} />
  ) : view === 'settings' ? (
    <Settings initialTab={s.settingsTab()} />
  ) : view === 'agents' ? (
    <Agents request={s.requestedChat()} onRequestHandled={s.chatHandled} />
  ) : view === 'linear' ? (
    <Linear
      projectRequest={s.linearProjectRequest()}
      onProjectRequestHandled={(request) => s.handleLinearProjectRequest(request)}
    />
  ) : view === 'vault' ? (
    <Vault />
  ) : s.modules.get(view)?.kind === 'web' ? (
    <WebAppView
      key={view}
      id={view.slice(WEB.length)}
      name={s.modules.get(view)?.name ?? 'Web app'}
    />
  ) : view === 'terminal' ? (
    <Terminal />
  ) : view === 'runtime' ? (
    <Runtime />
  ) : (
    <Projects onLinearProjectSelected={(request) => s.openLinearProject(request)} />
  );
}

/** The bar between split panes: drag it, or focus it and use the arrow keys. */
function SplitDivider({ s }: { s: HomeState }) {
  const percent = Math.round(s.splitRatio() * 100);
  return (
    <div
      className="split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
      aria-valuemin={MIN_SPLIT * 100}
      aria-valuemax={100 - MIN_SPLIT * 100}
      aria-valuenow={percent}
      tabIndex={0}
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const box = event.currentTarget.parentElement!.getBoundingClientRect();
        s.resizeSplit((event.clientX - box.left) / box.width);
      }}
      onPointerUp={() => s.saveSplit()}
      onDoubleClick={() => {
        s.resizeSplit(0.5);
        s.saveSplit();
      }}
      onKeyDown={(event) => {
        const step = { ArrowLeft: -0.05, ArrowRight: 0.05 }[event.key];
        if (step === undefined) return;
        event.preventDefault();
        s.resizeSplit(s.splitRatio() + step);
        s.saveSplit();
      }}
    />
  );
}

function AccountPage({ s }: { s: HomeState }) {
  const status = s.account.status();
  return (
    <section className="account-page" aria-labelledby="account-page-title">
      <header className="account-page-header">
        <button type="button" className="account-back" onClick={() => s.close('account')}>
          <Icon name="arrow-left" size={14} /> Back
        </button>
        <p className="u-caption">PROFILE</p>
        <h1 id="account-page-title">Your account</h1>
        <p>Identity and connection details provided by Nexus.</p>
      </header>
      {status.connected ? (
        <>
          <div className="account-profile-card">
            <div className="account-profile-avatar" aria-hidden="true">
              {s.avatar()}
            </div>
            <div className="account-profile-heading">
              <h2>{s.accountName()}</h2>
              <p>{status.email || 'Email unavailable'}</p>
            </div>
            <span className="account-connected">
              <span /> Connected
            </span>
          </div>
          <section className="account-details-card" aria-labelledby="account-details-title">
            <div className="account-details-heading">
              <div>
                <h2 id="account-details-title">Profile details</h2>
                <p>Synced from your Nexus account.</p>
              </div>
              <Icon name="lock" size={16} />
            </div>
            <dl>
              <div>
                <dt>Name</dt>
                <dd>{status.displayName || 'Not provided'}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{status.email || 'Not provided'}</dd>
              </div>
              <div className="account-id-row">
                <dt>Nexus account ID</dt>
                <dd>{status.userId || 'Not available'}</dd>
              </div>
            </dl>
          </section>
          <div className="account-page-actions">
            <div>
              <h2>Sign out of Relay</h2>
              <p>Your Nexus account stays active on other devices.</p>
            </div>
            <button
              type="button"
              disabled={s.account.busy()}
              onClick={() => void s.account.logout()}
            >
              {s.account.busy() ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
          <div className="account-page-actions">
            <div>
              <h2>Sign out everywhere</h2>
              <p>Ends Relay and every other app session on your Nexus account.</p>
            </div>
            <button
              type="button"
              disabled={s.account.busy()}
              onClick={() => void s.account.logout(true)}
            >
              Sign out everywhere
            </button>
          </div>
          {s.account.error() && (
            <p className="account-error" role="alert">
              {s.account.error()}
            </p>
          )}
        </>
      ) : (
        <div className="account-connect-card">
          <div className="account-profile-avatar" aria-hidden="true">
            N
          </div>
          <h2>Sign in with Nexus</h2>
          <p>Sign in to see the profile details Nexus shares with Relay.</p>
          <button
            type="button"
            disabled={!s.account.available}
            onClick={() => void s.account.login()}
          >
            Sign in with Nexus
          </button>
          {s.account.waiting() && <p>Waiting for sign-in in your browser…</p>}
          {s.account.error() && (
            <p className="account-error" role="alert">
              {s.account.error()}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
