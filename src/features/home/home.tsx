import { lazy, Suspense, useEffect } from 'react';

import { moduleHueVar } from '@/core/entity-hue';
import { ModuleRegistry } from '@/core/modules';
import { NexusAccount } from '@/core/nexus-account';
import { NotificationCenter } from '@/core/notification-center';
import { TauriBridge } from '@/core/tauri';
import { ThemeService } from '@/core/theme';
import Today from '@/features/today/today-view';
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
const Projects = lazy(() => import('@/features/projects/projects'));
const Modules = lazy(() => import('@/features/modules/modules'));

const INSPECTOR_SETTING_KEY = 'deck.inspector';

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
  readonly view = signal<HomeView>('today');
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

  readonly running = computed(() => this.center.items().filter((n) => n.status === 'running'));
  readonly needsYou = computed(() =>
    this.center.items().filter((n) => n.status === 'waiting' || n.status === 'blocked'),
  );

  /** Window and event listeners; returns their disposer. */
  start(): () => void {
    void this.modules.load();
    void this.tauri
      .getSetting<boolean>(INSPECTOR_SETTING_KEY, this.inspector())
      .then((stored) => this.inspector.set(stored));
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
    this.view.set(view);
  }

  close(view: HomeView): void {
    if (view === 'today') return;
    const tabs = this.openTabs();
    const at = tabs.indexOf(view);
    this.tabs.update((all) => all.filter((tab) => tab !== view));
    if (this.current() === view) this.view.set(tabs[at - 1] ?? 'today');
  }

  /** Browser tab keys: Ctrl+W closes the tab, Ctrl+Tab and Ctrl+Shift+Tab cycle. */
  private onKey(event: KeyboardEvent): void {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key.toLowerCase() === 'w' && !event.shiftKey) {
      event.preventDefault();
      this.close(this.current());
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const tabs = this.openTabs();
      const step = event.shiftKey ? -1 : 1;
      this.view.set(tabs[(tabs.indexOf(this.current()) + step + tabs.length) % tabs.length]);
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

  const view = s.current();
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
        <Kbd keys={['Ctrl', 'Space']} className="titlebar-kbd" />
        <div className="tabs" role="tablist" aria-label="Open views" data-tauri-drag-region="">
          {s.openTabs().map((tab) => (
            <div
              key={tab}
              className={cn('tab', view === tab && 'active')}
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
                onClick={() => s.view.set(tab)}
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
                {surface(tab).label}
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
        </div>
        <span className="activity" data-tauri-drag-region="">
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
        </span>
        <div className="window-controls">
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
                className={cn('rail-item', view === module.id && 'active')}
                onClick={() => s.open(module.id)}
                aria-label={surface(module.id).label}
                title={surface(module.id).label}
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
              title="Modules"
            >
              <Icon name="blocks" size={16} />
            </button>
            <button
              type="button"
              className={cn('rail-item', view === 'settings' && 'active')}
              onClick={() => s.openSettings()}
              aria-label="Settings"
              title="Settings"
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

        <main className="content" role="tabpanel" aria-label={surface(view).label}>
          <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
            {view === 'today' ? (
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
            ) : view === 'runtime' ? (
              <Runtime />
            ) : (
              <Projects onLinearProjectSelected={(request) => s.openLinearProject(request)} />
            )}
          </Suspense>
        </main>

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
