import { Fragment, createRef } from 'react';
import { Icon } from '@/shared/icon';
import { cn } from '@/lib/utils';
import { when } from '@/lib/jsx';
import { useController, useSignals } from '@/lib/signals';
import { DestroyRef } from '@/lib/signals';
import { onBackButtonPress } from '@tauri-apps/api/app';
import { inject } from '@/lib/inject';
import { computed, signal } from '@/lib/signals';

import type { Command, CommandMatch } from '@/core/command';
import { search } from '@/core/fuzzy';
import { NotificationCenter } from '@/core/notification-center';
import type { NotificationRecord } from '@/core/events';
import { ThemeService } from '@/core/theme';
import { TauriBridge, type MobileUpdate, type VaultStatus } from '@/core/tauri';
import Settings from '@/features/settings/settings';
import Vault from '@/features/vault/vault';
import { MobileConnections } from './mobile-connections';

type MobileTab = 'dashboard' | 'notifications' | 'vault' | 'connections' | 'settings';

interface MobileModule extends Command {
  readonly tab: MobileTab;
}

interface TitlePart {
  readonly text: string;
  readonly matched: boolean;
}

interface MobileModuleMatch extends Omit<CommandMatch, 'command'> {
  readonly command: MobileModule;
}

const MOBILE_MODULES: readonly MobileModule[] = [
  {
    id: 'mobile.dashboard',
    tab: 'dashboard',
    title: 'Dashboard',
    group: 'Modules',
    icon: 'house',
    keywords: ['home', 'overview'],
    run: () => undefined,
  },
  {
    id: 'mobile.notifications',
    tab: 'notifications',
    title: 'Notifications',
    group: 'Modules',
    icon: 'inbox',
    keywords: ['inbox', 'activity', 'alerts'],
    run: () => undefined,
  },
  {
    id: 'mobile.vault',
    tab: 'vault',
    title: 'Password vault',
    group: 'Modules',
    icon: 'lock',
    keywords: ['password', 'secret', 'account'],
    run: () => undefined,
  },
  {
    id: 'mobile.connections',
    tab: 'connections',
    title: 'Connections',
    group: 'Modules',
    icon: 'plus',
    keywords: ['connect', 'github', 'gmail'],
    run: () => undefined,
  },
  {
    id: 'mobile.settings',
    tab: 'settings',
    title: 'Settings',
    group: 'Modules',
    icon: 'settings',
    keywords: ['preferences', 'appearance'],
    run: () => undefined,
  },
];

import './mobile.css';

export class MobileState {
  private readonly center = inject(NotificationCenter);
  private readonly tauri = inject(TauriBridge);
  readonly theme = inject(ThemeService);
  readonly destroyRef = new DestroyRef();
  readonly moduleSearch = createRef<HTMLInputElement>();
  readonly rail = createRef<HTMLElement>();
  readonly railToggleButton = createRef<HTMLButtonElement>();
  readonly railCloseButton = createRef<HTMLButtonElement>();
  readonly pageTitle = createRef<HTMLHeadingElement>();

  private railGesture: {
    pointerId: number;
    startX: number;
    startY: number;
    startTime: number;
    startedOpen: boolean;
    intent: boolean;
  } | null = null;
  private notificationSwipe: {
    notificationId: string;
    pointerId: number;
    startX: number;
    startY: number;
  } | null = null;
  private pendingRailBackAt = 0;
  private suppressClickFor: string | null = null;

  readonly tab = signal<MobileTab>('dashboard');
  readonly focusModuleHeading = signal(false);
  readonly moduleQuery = signal('');
  readonly activeModuleIndex = signal(0);
  readonly moduleMatches = computed<readonly MobileModuleMatch[]>(() =>
    search(MOBILE_MODULES, this.moduleQuery()).map((match) => ({
      ...match,
      command: MOBILE_MODULES.find((module) => module.id === match.command.id)!,
    })),
  );
  readonly activeModule = computed(() => this.moduleMatches()[this.activeModuleIndex()]?.command);
  readonly railOpen = signal(false);
  readonly railProgress = signal(0);
  readonly railGestureActive = signal(false);
  readonly swipeState = signal<{ notificationId: string; offset: number } | null>(null);
  readonly notifications = this.center.history;
  readonly unreadCount = computed(
    () => this.notifications().filter((notification) => !notification.read).length,
  );
  readonly recentNotifications = computed(() => this.notifications().slice(0, 4));
  readonly vaultStatus = signal<VaultStatus>({ exists: false, unlocked: false });
  readonly connectionSummary = signal('Not connected');
  readonly mobileUpdate = signal<MobileUpdate | null>(null);
  readonly updateBusy = signal(false);
  readonly tabTitle = computed(() =>
    this.tab() === 'dashboard'
      ? 'Your dashboard'
      : this.tab() === 'notifications'
        ? 'Notifications'
        : this.tab() === 'vault'
          ? 'Password vault'
          : this.tab() === 'settings'
            ? 'Settings'
            : 'Connections',
  );
  readonly vaultLabel = computed(() => {
    const status = this.vaultStatus();
    return !status.exists ? 'Not set up' : status.unlocked ? 'Unlocked' : 'Locked';
  });

  constructor() {
    this.destroyRef.effect(() => {
      const focusHeading = this.focusModuleHeading();
      const railOpen = this.railOpen();
      const timer = setTimeout(() => {
        if (focusHeading) {
          this.pageTitle.current?.focus();
          this.focusModuleHeading.set(false);
        } else if (railOpen) {
          this.moduleSearch.current?.focus();
        }
      });
      return () => clearTimeout(timer);
    });
    void this.refresh();
    void this.checkForUpdate();
    void onBackButtonPress(({ canGoBack }) => {
      const edgeSwipe = Date.now() - this.pendingRailBackAt < 700;
      this.pendingRailBackAt = 0;
      if (edgeSwipe && !this.railOpen()) {
        this.setRailOpen(true);
      } else if (this.railOpen()) {
        this.closeRail();
      } else if (this.tab() !== 'dashboard') {
        this.tab.set('dashboard');
      } else if (canGoBack) {
        window.history.back();
      }
    })
      .then((listener) => this.destroyRef.onDestroy(() => void listener.unregister()))
      .catch(() => undefined);
  }

  async refresh(): Promise<void> {
    const [vaultStatus, githubStatus, gmailStatus] = await Promise.all([
      this.tauri.vaultStatus(),
      this.tauri.githubStatus(),
      this.tauri.gmailStatus(),
    ]);
    this.vaultStatus.set(vaultStatus);
    const connected = Number(githubStatus.connected) + Number(gmailStatus.connected);
    this.connectionSummary.set(connected === 0 ? 'Not connected' : `${connected}/2 connected`);
  }

  private async checkForUpdate(): Promise<void> {
    if (!/Android/i.test(navigator.userAgent)) return;
    try {
      this.mobileUpdate.set(await this.tauri.mobileUpdateCheck());
    } catch (error: unknown) {
      console.warn('[relay] mobile update check failed', error);
    }
  }

  async installUpdate(update: MobileUpdate): Promise<void> {
    if (this.updateBusy()) return;
    this.updateBusy.set(true);
    try {
      await this.tauri.openUrl(update.apkUrl);
    } finally {
      this.updateBusy.set(false);
    }
  }

  openNotification(notification: NotificationRecord, event?: MouseEvent): void {
    if (event && this.suppressClickFor === notification.notificationId) {
      event.preventDefault();
      event.stopPropagation();
      this.suppressClickFor = null;
      return;
    }
    this.center.markRead(notification.notificationId);
    void this.tauri.notificationsMarkRead([notification.notificationId]);

    const action = notification.actions?.find((item) => item.id === 'open');
    if (action?.id === 'open') void this.tauri.openUrl(action.url);
  }

  clearNotifications(): void {
    this.center.clearHistory();
    void this.tauri.notificationsClear();
  }

  toggleRail(): void {
    if (this.railOpen()) {
      this.closeRail();
      return;
    }

    this.openCommandMenu();
  }

  closeRail(): void {
    this.moduleQuery.set('');
    this.setRailOpen(false);
  }

  onRailTransitionEnd(event: TransitionEvent): void {
    if (event.propertyName === 'transform' && this.railOpen()) {
      this.moduleSearch.current?.focus();
    }
  }

  selectTab(tab: MobileTab): void {
    this.tab.set(tab);
    this.closeRail();
  }

  openCommandMenu(): void {
    this.moduleQuery.set('');
    this.activeModuleIndex.set(
      Math.max(
        0,
        MOBILE_MODULES.findIndex((module) => module.tab === this.tab()),
      ),
    );
    this.setRailOpen(true);
  }

  onModuleQuery(value: string): void {
    this.moduleQuery.set(value);
    this.activeModuleIndex.set(0);
  }

  moduleIndex(match: MobileModuleMatch): number {
    return this.moduleMatches().indexOf(match);
  }

  moduleTitleParts(match: CommandMatch): readonly TitlePart[] {
    const parts: TitlePart[] = [];
    let cursor = 0;
    for (const [start, end] of match.ranges) {
      if (start > cursor)
        parts.push({ text: match.command.title.slice(cursor, start), matched: false });
      parts.push({ text: match.command.title.slice(start, end), matched: true });
      cursor = end;
    }
    if (cursor < match.command.title.length) {
      parts.push({ text: match.command.title.slice(cursor), matched: false });
    }
    return parts;
  }

  selectModule(module: MobileModule): void {
    this.selectTab(module.tab);
    this.focusModuleHeading.set(true);
  }

  onShellKeydown(event: KeyboardEvent): void {
    if (!this.railOpen()) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        this.openCommandMenu();
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeRail();
      return;
    }

    const input = this.moduleSearch.current;
    if (event.key === 'Tab' && event.target !== input) {
      const panel = this.rail.current;
      const focusable = panel?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled])',
      );
      const first = focusable?.[0] ?? input;
      const last = focusable?.[focusable.length - 1] ?? input;
      const outsidePanel = !panel?.contains(event.target as Node);
      if (outsidePanel || (event.shiftKey ? event.target === first : event.target === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
      return;
    }

    if (event.target !== this.moduleSearch.current) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveModule(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveModule(-1);
        break;
      case 'Enter':
        event.preventDefault();
        {
          const active = this.activeModule();
          if (active) this.selectModule(active);
        }
        break;
      case 'Tab':
        if (this.moduleQuery().trim()) {
          const active = this.activeModule();
          const input = this.moduleSearch.current;
          if (active && input) {
            event.preventDefault();
            input.value = active.title;
            this.onModuleQuery(input.value);
          } else {
            event.preventDefault();
            this.railCloseButton.current?.focus();
          }
        }
        break;
    }
  }

  private moveModule(delta: number): void {
    const count = this.moduleMatches().length;
    if (count) this.activeModuleIndex.update((index) => (index + delta + count) % count);
  }

  startRailGesture(event: PointerEvent): void {
    if (!event.isPrimary) return;
    this.railGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: event.timeStamp,
      startedOpen: this.railOpen(),
      intent: false,
    };
  }

  moveRailGesture(event: PointerEvent): void {
    const gesture = this.railGesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.intent) {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 10) return;
      if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.15) {
        this.railGesture = null;
        return;
      }
      if (gesture.startedOpen ? deltaX >= 0 : deltaX <= 0) {
        this.railGesture = null;
        return;
      }

      gesture.intent = true;
      this.railGestureActive.set(true);
      this.railOpen.set(true);
    }

    event.preventDefault();
    const width = Math.min(window.innerWidth * 0.82, 288);
    const progress = Math.max(0, Math.min(1, (gesture.startedOpen ? 1 : 0) + deltaX / width));
    this.railProgress.set(progress);
  }

  endRailGesture(event: PointerEvent): void {
    const gesture = this.railGesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!gesture.intent) {
      this.railGesture = null;
      return;
    }

    const deltaX = event.clientX - gesture.startX;
    const duration = Math.max(1, event.timeStamp - gesture.startTime);
    const velocity = deltaX / duration;
    const width = Math.min(window.innerWidth * 0.82, 288);
    const progress = Math.max(0, Math.min(1, (gesture.startedOpen ? 1 : 0) + deltaX / width));
    const open = gesture.startedOpen
      ? !(progress < 0.62 || (deltaX <= -56 && velocity < -0.55))
      : progress >= 0.34 || (deltaX >= 56 && velocity > 0.55);
    this.setRailOpen(open);
  }

  cancelRailGesture(event?: PointerEvent): void {
    const gesture = this.railGesture;
    if (gesture && event && !this.railOpen() && gesture.startX <= 32) {
      // ponytail: pair edge pointercancel with Android Back; use native exclusion rectangles if unreliable.
      this.pendingRailBackAt = Date.now();
    }
    if (gesture) this.setRailOpen(gesture.startedOpen);
  }

  private setRailOpen(open: boolean): void {
    const wasOpen = this.railOpen();
    this.railGesture = null;
    this.railGestureActive.set(false);
    this.railOpen.set(open);
    this.railProgress.set(open ? 1 : 0);
    if (open) return;

    this.moduleQuery.set('');
    this.activeModuleIndex.set(0);
    if (wasOpen) {
      this.railToggleButton.current?.focus();
    }
  }

  startNotificationSwipe(event: PointerEvent, notificationId: string): void {
    if (!event.isPrimary || event.pointerType === 'mouse') return;
    this.notificationSwipe = {
      notificationId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  moveNotificationSwipe(event: PointerEvent): void {
    if (!this.notificationSwipe || event.pointerId !== this.notificationSwipe.pointerId) return;
    const deltaX = event.clientX - this.notificationSwipe.startX;
    const deltaY = event.clientY - this.notificationSwipe.startY;
    if (Math.abs(deltaX) <= Math.abs(deltaY)) return;
    event.preventDefault();
    this.swipeState.set({
      notificationId: this.notificationSwipe.notificationId,
      offset: Math.max(-120, Math.min(0, deltaX)),
    });
  }

  endNotificationSwipe(event: PointerEvent): void {
    if (!this.notificationSwipe || event.pointerId !== this.notificationSwipe.pointerId) return;
    const deltaX = event.clientX - this.notificationSwipe.startX;
    const deltaY = event.clientY - this.notificationSwipe.startY;
    if (mobileSwipeAction(deltaX, deltaY) === 'mark-read') {
      this.suppressClickFor = this.notificationSwipe.notificationId;
      this.center.markRead(this.notificationSwipe.notificationId);
      void this.tauri.notificationsMarkRead([this.notificationSwipe.notificationId]);
    }
    this.cancelNotificationSwipe();
  }

  cancelNotificationSwipe(): void {
    this.notificationSwipe = null;
    this.swipeState.set(null);
  }

  swipeOffset(notificationId: string): number {
    const state = this.swipeState();
    return state?.notificationId === notificationId ? state.offset : 0;
  }

  isSwiping(notificationId: string): boolean {
    return this.swipeState()?.notificationId === notificationId;
  }
}

export function mobileSwipeAction(
  deltaX: number,
  deltaY: number,
): 'open-rail' | 'mark-read' | null {
  if (Math.abs(deltaX) <= Math.abs(deltaY) || Math.abs(deltaX) < 72) return null;
  return deltaX > 0 ? 'open-rail' : 'mark-read';
}

export default function Mobile() {
  useSignals();
  const s = useController(() => new MobileState());
  return (
    <div className="mobile">
      <div
        className="mobile-shell"
        tabIndex={0}
        onKeyDown={($event) => {
          void s.onShellKeydown($event.nativeEvent);
        }}
        onPointerDown={($event) => {
          void s.startRailGesture($event.nativeEvent);
        }}
        onPointerMove={($event) => {
          void s.moveRailGesture($event.nativeEvent);
        }}
        onPointerUp={($event) => {
          void s.endRailGesture($event.nativeEvent);
        }}
        onPointerCancel={($event) => {
          void s.cancelRailGesture($event.nativeEvent);
        }}
      >
        <header className="mobile-header">
          <button
            className="header-button"
            ref={s.railToggleButton}
            type="button"
            onClick={() => {
              void s.toggleRail();
            }}
            aria-expanded={s.railOpen()}
            aria-label={s.railOpen() ? 'Close navigation' : 'Open navigation'}
            aria-controls="mobile-rail"
          >
            <Icon name="panel-left" size={16} />
          </button>
          <div className="mobile-header-title">
            <p className="eyebrow">Relay</p>
            <h1 ref={s.pageTitle} tabIndex={-1}>
              {s.tabTitle()}
            </h1>
          </div>
          <div className="header-actions">
            <button
              className="header-button"
              type="button"
              onClick={() => {
                void s.openCommandMenu();
              }}
              aria-label="Find a module"
            >
              <Icon name="search" size={16} />
            </button>
            <button
              className="header-button"
              type="button"
              onClick={() => {
                void s.theme.toggle();
              }}
              aria-label={
                s.theme.theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
              }
              title={s.theme.theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              <Icon name={s.theme.theme() === 'dark' ? 'sun' : 'moon'} size={16} />
            </button>
          </div>
        </header>

        <button
          className={cn(
            'rail-backdrop',
            s.railOpen() && 'open',
            s.railGestureActive() && 'dragging',
          )}
          type="button"
          aria-hidden={!s.railOpen()}
          inert={(s.railOpen() ? undefined : '') !== undefined}
          onClick={() => {
            void s.closeRail();
          }}
          aria-label="Close navigation"
          style={{ opacity: s.railProgress() }}
        />
        <aside
          className={cn('mobile-rail', s.railOpen() && 'open', s.railGestureActive() && 'dragging')}
          ref={s.rail}
          id="mobile-rail"
          aria-hidden={!s.railOpen()}
          aria-modal={s.railOpen() ? 'true' : undefined}
          inert={(s.railOpen() ? undefined : '') !== undefined}
          onTransitionEnd={($event) => {
            void s.onRailTransitionEnd($event.nativeEvent);
          }}
          role="dialog"
          aria-label="Relay navigation"
          style={{ transform: 'translate3d(' + (s.railProgress() - 1) * 100 + '%, 0, 0)' }}
        >
          <div className="rail-heading">
            <span className="eyebrow">Go to</span>
            <button
              className="rail-close"
              ref={s.railCloseButton}
              type="button"
              onClick={() => {
                void s.closeRail();
              }}
              aria-label="Close navigation"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          <label className="rail-search">
            <Icon name="search" size={16} />
            <input
              ref={s.moduleSearch}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="Find a module"
              aria-label="Find a module"
              role="combobox"
              aria-autocomplete="list"
              value={s.moduleQuery()}
              aria-expanded={s.railOpen()}
              aria-controls="mobile-module-results"
              aria-activedescendant={
                s.activeModule() ? `mobile-${s.activeModule()?.id}` : undefined
              }
              onChange={($event) => {
                void s.onModuleQuery($event.currentTarget.value);
              }}
            />
          </label>
          <div
            className="rail-modules"
            id="mobile-module-results"
            role="listbox"
            aria-label="Modules"
          >
            {s.moduleMatches().map((match) => {
              return (
                <Fragment key={match.command.id}>
                  {((module) => (
                    <>
                      {((index) => (
                        <>
                          <button
                            className={cn(
                              'rail-item',
                              s.tab() === module.tab && 'active',
                              index === s.activeModuleIndex() && 'command-active',
                            )}
                            type="button"
                            role="option"
                            id={'mobile-' + module.id}
                            aria-label={module.title}
                            aria-current={s.tab() === module.tab ? 'page' : undefined}
                            aria-selected={index === s.activeModuleIndex()}
                            onClick={() => {
                              void s.selectModule(module);
                            }}
                            onMouseMove={() => {
                              void s.activeModuleIndex.set(index);
                            }}
                          >
                            <Icon name={module.icon ?? 'circle'} size={16} />
                            <span className="module-label">
                              {s.moduleTitleParts(match).map((part, $index) => {
                                return (
                                  <Fragment key={$index}>
                                    {part.matched ? (
                                      <>
                                        <mark>{part.text}</mark>
                                      </>
                                    ) : (
                                      <>{part.text}</>
                                    )}
                                  </Fragment>
                                );
                              })}
                            </span>
                            {module.tab === 'notifications' && s.unreadCount() > 0 ? (
                              <>
                                <span className="rail-badge">{s.unreadCount()}</span>
                              </>
                            ) : null}
                          </button>
                        </>
                      ))(s.moduleIndex(match))}
                    </>
                  ))(match.command)}
                </Fragment>
              );
            })}
          </div>
          {s.moduleMatches().length === 0 ? (
            <>
              <p className="module-empty" role="status" aria-live="polite">
                No matching module
              </p>
            </>
          ) : null}
        </aside>

        <main className="mobile-content">
          {s.tab() === 'dashboard' ? (
            <>
              <section className="welcome">
                <p className="eyebrow">Good to have you back</p>
                <p className="welcome-copy">
                  The things worth checking, without the desktop overhead.
                </p>
              </section>

              <div className="summary-grid">
                <button
                  className="summary-card"
                  type="button"
                  onClick={() => {
                    void s.tab.set('notifications');
                  }}
                >
                  <span className="summary-icon">
                    <Icon name="inbox" size={16} />
                  </span>
                  <span className="summary-value">{s.unreadCount()}</span>
                  <span className="summary-label">Unread notifications</span>
                </button>
                <button
                  className="summary-card"
                  type="button"
                  onClick={() => {
                    void s.tab.set('vault');
                  }}
                >
                  <span className="summary-icon">
                    <Icon name="lock" size={16} />
                  </span>
                  <span className="summary-value">{s.vaultLabel()}</span>
                  <span className="summary-label">Password vault</span>
                </button>
                <button
                  className="summary-card"
                  type="button"
                  onClick={() => {
                    void s.selectTab('connections');
                  }}
                >
                  <span className="summary-icon">
                    <Icon name="settings" size={16} />
                  </span>
                  <span className="summary-value">{s.connectionSummary()}</span>
                  <span className="summary-label">Connections</span>
                </button>
              </div>

              {when(s.mobileUpdate(), (update) => (
                <>
                  <section className="mobile-update">
                    <div>
                      <p className="eyebrow">Update available</p>
                      <h2>Relay {update.latestVersion}</h2>
                      <p className="section-copy">A newer Android build is ready to install.</p>
                    </div>
                    <button
                      className="text-button"
                      type="button"
                      disabled={s.updateBusy()}
                      onClick={() => {
                        void s.installUpdate(update);
                      }}
                    >
                      {s.updateBusy() ? 'Opening…' : 'Install'}
                    </button>
                  </section>
                </>
              ))}

              <section className="section">
                <div className="section-heading">
                  <h2>Recent activity</h2>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      void s.tab.set('notifications');
                    }}
                  >
                    See all
                  </button>
                </div>
                {s.recentNotifications().length === 0 ? (
                  <>
                    <p className="empty-card">Nothing new yet.</p>
                  </>
                ) : (
                  <>
                    <div className="activity-list">
                      {s.recentNotifications().map((notification) => {
                        return (
                          <Fragment key={notification.notificationId}>
                            <button
                              className={cn('activity-row', !notification.read && 'unread')}
                              type="button"
                              onClick={() => {
                                void s.openNotification(notification);
                              }}
                            >
                              <span className="status-dot" data-status={notification.status} />
                              <span className="activity-copy">
                                <strong>{notification.title}</strong>
                                <span>{notification.detail || 'Relay notification'}</span>
                              </span>
                              <Icon name="chevron-right" size={16} />
                            </button>
                          </Fragment>
                        );
                      })}
                    </div>
                  </>
                )}
              </section>
            </>
          ) : s.tab() === 'notifications' ? (
            <>
              <section className="section full-section">
                <div className="section-heading">
                  <div>
                    <h2>Notifications</h2>
                    <p className="section-copy">{s.unreadCount()} unread</p>
                  </div>
                  <button
                    className="text-button"
                    type="button"
                    disabled={s.notifications().length === 0}
                    onClick={() => {
                      void s.clearNotifications();
                    }}
                  >
                    Clear
                  </button>
                </div>
                {s.notifications().length === 0 ? (
                  <>
                    <p className="empty-card">Nothing new.</p>
                  </>
                ) : (
                  <>
                    <div className="activity-list">
                      {s.notifications().map((notification) => {
                        return (
                          <Fragment key={notification.notificationId}>
                            <div className="notification-swipe">
                              <span className="swipe-action" aria-hidden="true">
                                Mark read
                              </span>
                              <button
                                className={cn(
                                  'activity-row',
                                  !notification.read && 'unread',
                                  s.isSwiping(notification.notificationId) && 'swiping',
                                )}
                                type="button"
                                onPointerDown={($event) => {
                                  void s.startNotificationSwipe(
                                    $event.nativeEvent,
                                    notification.notificationId,
                                  );
                                }}
                                onPointerMove={($event) => {
                                  void s.moveNotificationSwipe($event.nativeEvent);
                                }}
                                onPointerUp={($event) => {
                                  void s.endNotificationSwipe($event.nativeEvent);
                                }}
                                onPointerCancel={() => {
                                  void s.cancelNotificationSwipe();
                                }}
                                onClick={($event) => {
                                  void s.openNotification(notification, $event.nativeEvent);
                                }}
                                style={{
                                  transform:
                                    'translateX(' +
                                    s.swipeOffset(notification.notificationId) +
                                    'px)',
                                }}
                              >
                                <span className="status-dot" data-status={notification.status} />
                                <span className="activity-copy">
                                  <strong>{notification.title}</strong>
                                  <span>{notification.detail || 'Relay notification'}</span>
                                </span>
                                <Icon name="chevron-right" size={16} />
                              </button>
                            </div>
                          </Fragment>
                        );
                      })}
                    </div>
                  </>
                )}
              </section>
            </>
          ) : s.tab() === 'settings' ? (
            <>
              <Settings />
            </>
          ) : s.tab() === 'vault' ? (
            <>
              <section className="section full-section vault-section">
                <Vault />
              </section>
            </>
          ) : (
            <>
              <section className="section full-section connections-section">
                <MobileConnections />
              </section>
            </>
          )}
        </main>

        <nav className="mobile-nav" aria-label="Mobile navigation">
          <button
            className={cn(s.tab() === 'dashboard' && 'active')}
            type="button"
            onClick={() => {
              void s.selectTab('dashboard');
            }}
            aria-current={s.tab() === 'dashboard' ? 'page' : undefined}
            aria-label="Dashboard"
          >
            <Icon name="house" size={16} />
            <span>Home</span>
          </button>
          <button
            className={cn(s.tab() === 'notifications' && 'active')}
            type="button"
            onClick={() => {
              void s.selectTab('notifications');
            }}
            aria-current={s.tab() === 'notifications' ? 'page' : undefined}
            aria-label="Notifications"
          >
            <span className="nav-icon">
              <Icon name="inbox" size={16} />
              {s.unreadCount() > 0 ? (
                <>
                  <span className="nav-badge">{s.unreadCount()}</span>
                </>
              ) : null}
            </span>
            <span>Inbox</span>
          </button>
          <button
            className={cn(s.tab() === 'vault' && 'active')}
            type="button"
            onClick={() => {
              void s.selectTab('vault');
            }}
            aria-current={s.tab() === 'vault' ? 'page' : undefined}
            aria-label="Password vault"
          >
            <Icon name="lock" size={16} />
            <span>Vault</span>
          </button>
          <button
            className={cn(s.tab() === 'connections' && 'active')}
            type="button"
            onClick={() => {
              void s.selectTab('connections');
            }}
            aria-current={s.tab() === 'connections' ? 'page' : undefined}
          >
            <Icon name="plus" size={16} />
            <span>Connect</span>
          </button>
          <button
            className={cn(s.tab() === 'settings' && 'active')}
            type="button"
            onClick={() => {
              void s.selectTab('settings');
            }}
            aria-current={s.tab() === 'settings' ? 'page' : undefined}
          >
            <Icon name="settings" size={16} />
            <span>Settings</span>
          </button>
        </nav>
      </div>
    </div>
  );
}
