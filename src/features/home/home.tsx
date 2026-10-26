import { lazy, Suspense, useEffect } from 'react';

import { NexusAccount } from '@/core/nexus-account';
import { TauriBridge } from '@/core/tauri';
import { ThemeService } from '@/core/theme';
import { UpdateStatusBar } from '@/features/updates/update-status-bar';
import { inject } from '@/lib/inject';
import { computed, signal, useSignals } from '@/lib/signals';
import { cn } from '@/lib/utils';
import { AppPopover, PopoverClose, PopoverContent, PopoverTrigger } from '@/shared/app-popover';
import { BackgroundTaskIndicator } from '@/shared/background-task-indicator';
import { Icon } from '@/shared/icon';
import { NotificationPopover } from '@/shared/notification-popover';

import './home.css';

const Settings = lazy(() => import('@/features/settings/settings'));
const Codex = lazy(() => import('@/features/codex/codex'));
const Linear = lazy(() => import('@/features/linear/linear'));
const Vault = lazy(() => import('@/features/vault/vault'));
const Runtime = lazy(() => import('@/features/runtime/runtime'));
const Projects = lazy(() => import('@/features/projects/projects'));

const RAIL_EXPANDED_SETTING_KEY = 'rail.expanded';

export type HomeView = 'home' | 'linear' | 'settings' | 'vault' | 'runtime' | 'codex' | 'account';
export type SettingsTab = 'general' | 'github' | 'linear';
export interface LinearProjectRequest {
  readonly organizationId: string;
  readonly projectId: string;
}

/** The main window's navigation state. One per main window. */
export class HomeState {
  readonly account = inject(NexusAccount);
  readonly theme = inject(ThemeService);
  private readonly tauri = inject(TauriBridge);

  readonly accountName = computed(
    () => this.account.status().displayName || this.account.status().email || 'Nexus account',
  );
  readonly avatar = computed(() =>
    this.account.status().connected ? this.accountName().trim().charAt(0).toLocaleUpperCase() : 'N',
  );
  readonly view = signal<HomeView>('home');
  readonly requestedAgentThreadId = signal<string | null>(null);
  readonly linearProjectRequest = signal<LinearProjectRequest | null>(null);
  /** Starts collapsed, the safe default while the stored value loads, then follows it. */
  readonly railExpanded = signal(false);
  readonly settingsTab = signal<SettingsTab>('general');
  readonly maximized = signal(false);

  /** Window and event listeners; returns their disposer. */
  start(): () => void {
    void this.tauri
      .getSetting<boolean>(RAIL_EXPANDED_SETTING_KEY, this.railExpanded())
      .then((stored) => this.railExpanded.set(stored));
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
        if (event.type === 'openVaultRequested') this.view.set('vault');
        if (event.type === 'openRuntimeRequested') this.view.set('runtime');
        if (event.type === 'openAgentsRequested') this.view.set('codex');
        if (event.type === 'openAgentThreadRequested') {
          this.requestedAgentThreadId.set(event.threadId);
          this.view.set('codex');
        }
        if (event.type === 'openGithubRequested') {
          this.view.set('settings');
          this.settingsTab.set('github');
        }
        if (event.type === 'openLinearRequested') this.view.set('linear');
      }),
    ];
    return () => unlisteners.forEach((p) => void p.then((stop) => stop()));
  }

  openLinearProject(request: LinearProjectRequest): void {
    this.linearProjectRequest.set(request);
    this.view.set('linear');
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

  openSettings(): void {
    this.view.set('settings');
    this.settingsTab.set('general');
  }

  toggleRail(): void {
    const expanded = !this.railExpanded();
    this.railExpanded.set(expanded);
    void this.tauri.setSetting(RAIL_EXPANDED_SETTING_KEY, expanded);
  }

  minimize(): void {
    void this.tauri.minimizeWindow();
  }

  toggleMaximize(): void {
    void this.tauri.toggleMaximizeWindow();
  }

  close(): void {
    void this.tauri.closeWindow();
  }
}

const RAIL: readonly { view: HomeView; icon: string; label: string }[] = [
  { view: 'linear', icon: 'inbox', label: 'My work' },
  { view: 'home', icon: 'library', label: 'Projects' },
  { view: 'runtime', icon: 'info', label: 'Runtime' },
  { view: 'codex', icon: 'command', label: 'Codex' },
];

/**
 * The main window. `decorations: false` in tauri.conf.json means the OS draws
 * no title bar, so everything here — the window buttons and the rail included
 * — is drawn by Relay and must behave like a native shell: a titlebar that
 * never scrolls away, and window buttons flush with the window's own edges.
 */
export default function Home() {
  useSignals();
  const s = inject(HomeState);
  useEffect(() => s.start(), [s]);

  const view = s.view();
  const status = s.account.status();

  return (
    <div className="home">
      <header className="titlebar u-chrome" data-tauri-drag-region="">
        <div className="titlebar-start">
          <button
            type="button"
            className={cn('home-btn', view === 'home' && 'active')}
            onClick={() => s.view.set('home')}
            aria-label="Home"
          >
            <Icon name="house" size={16} />
          </button>
          <span className="wordmark">Relay</span>
          <NotificationPopover />
        </div>
        <div className="window-controls">
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
            onClick={() => s.close()}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      </header>

      <div className="body">
        <nav className={cn('rail u-chrome', s.railExpanded() && 'expanded')}>
          <div className="rail-top">
            <button
              type="button"
              className="rail-toggle"
              onClick={() => s.toggleRail()}
              aria-label={s.railExpanded() ? 'Collapse sidebar' : 'Expand sidebar'}
            >
              <Icon name="panel-left" size={16} />
            </button>
            {RAIL.map((item) => (
              <button
                key={item.view}
                type="button"
                className={cn('rail-item', view === item.view && 'active')}
                onClick={() => s.view.set(item.view)}
                aria-label={item.label}
              >
                <span className="rail-icon">
                  <Icon name={item.icon} size={16} />
                </span>
                <span className="rail-label">{item.label}</span>
              </button>
            ))}
          </div>

          <div className="rail-bottom">
            <button
              type="button"
              className={cn('rail-item', view === 'settings' && 'active')}
              onClick={() => s.openSettings()}
              aria-label="Settings"
            >
              <span className="rail-icon">
                <Icon name="settings" size={16} />
              </span>
              <span className="rail-label">Settings</span>
            </button>
            <AppPopover>
              <PopoverTrigger>
                <button
                  type="button"
                  className="rail-item account-trigger"
                  aria-label="Nexus account"
                  title={status.connected ? s.accountName() : 'Sign in with Nexus'}
                >
                  <span className="rail-icon">
                    <span className="avatar" aria-hidden="true">
                      {s.avatar()}
                    </span>
                  </span>
                  <span className="rail-label">
                    {status.connected ? s.accountName() : 'Account'}
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
                      <button type="button" role="menuitem" onClick={() => s.view.set('account')}>
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

        <main className="content">
          <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
            {view === 'account' ? (
              <AccountPage s={s} />
            ) : view === 'settings' ? (
              <Settings initialTab={s.settingsTab()} />
            ) : view === 'codex' ? (
              <Codex
                openThreadId={s.requestedAgentThreadId()}
                onThreadHandled={() => s.requestedAgentThreadId.set(null)}
              />
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
      </div>

      <footer className="statusbar u-chrome">
        <UpdateStatusBar />
        <BackgroundTaskIndicator />
      </footer>
    </div>
  );
}

function AccountPage({ s }: { s: HomeState }) {
  const status = s.account.status();
  return (
    <section className="account-page" aria-labelledby="account-page-title">
      <header className="account-page-header">
        <button type="button" className="account-back" onClick={() => s.view.set('home')}>
          <Icon name="arrow-left" size={14} /> Back to projects
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
