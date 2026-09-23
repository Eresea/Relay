import { onBackButtonPress } from '@tauri-apps/api/app';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';

import { NotificationCenter } from '@core/notification-center';
import type { NotificationRecord } from '@core/events';
import { TauriBridge, type MobileUpdate, type VaultStatus } from '@core/tauri';
import { Vault } from '@features/vault/vault';
import { Icon } from '@shared/icon';
import { MobileConnections } from './mobile-connections';

type MobileTab = 'dashboard' | 'notifications' | 'vault' | 'connections';

@Component({
  selector: 'rl-mobile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, MobileConnections, Vault],
  template: `
    <div
      class="mobile-shell"
      (pointerdown)="startRailGesture($event)"
      (pointermove)="moveRailGesture($event)"
      (pointerup)="endRailGesture($event)"
      (pointercancel)="cancelRailGesture()"
    >
      <header class="mobile-header">
        <button
          type="button"
          class="header-button"
          (click)="toggleRail()"
          [attr.aria-expanded]="railOpen()"
          [attr.aria-label]="railOpen() ? 'Close navigation' : 'Open navigation'"
          aria-controls="mobile-rail"
        >
          <rl-icon name="panel-left" [size]="16" />
        </button>
        <div>
          <p class="eyebrow">Relay</p>
          <h1>{{ tabTitle() }}</h1>
        </div>
        <button
          type="button"
          class="header-button"
          (click)="refresh()"
          aria-label="Refresh dashboard"
        >
          <rl-icon name="loader-circle" [size]="16" />
        </button>
      </header>

      @if (railOpen()) {
        <button
          type="button"
          class="rail-backdrop"
          (click)="closeRail()"
          aria-label="Close navigation"
        ></button>
        <aside id="mobile-rail" class="mobile-rail" aria-label="Relay navigation">
          <div class="rail-heading">
            <span class="eyebrow">Relay</span>
            <button
              type="button"
              class="rail-close"
              (click)="closeRail()"
              aria-label="Close navigation"
            >
              <rl-icon name="x" [size]="16" />
            </button>
          </div>
          <button
            type="button"
            class="rail-item"
            [class.active]="tab() === 'dashboard'"
            (click)="selectTab('dashboard')"
          >
            <rl-icon name="house" [size]="16" />
            <span>Dashboard</span>
          </button>
          <button
            type="button"
            class="rail-item"
            [class.active]="tab() === 'notifications'"
            (click)="selectTab('notifications')"
          >
            <rl-icon name="inbox" [size]="16" />
            <span>Notifications</span>
            @if (unreadCount() > 0) {
              <span class="rail-badge">{{ unreadCount() }}</span>
            }
          </button>
          <button
            type="button"
            class="rail-item"
            [class.active]="tab() === 'vault'"
            (click)="selectTab('vault')"
          >
            <rl-icon name="lock" [size]="16" />
            <span>Password vault</span>
          </button>
          <button
            type="button"
            class="rail-item"
            [class.active]="tab() === 'connections'"
            (click)="selectTab('connections')"
          >
            <rl-icon name="settings" [size]="16" />
            <span>Connections</span>
          </button>
        </aside>
      }

      <main class="mobile-content">
        @if (tab() === 'dashboard') {
          <section class="welcome">
            <p class="eyebrow">Good to have you back</p>
            <p class="welcome-copy">The things worth checking, without the desktop overhead.</p>
          </section>

          <div class="summary-grid">
            <button type="button" class="summary-card" (click)="tab.set('notifications')">
              <span class="summary-icon"><rl-icon name="inbox" [size]="16" /></span>
              <span class="summary-value">{{ unreadCount() }}</span>
              <span class="summary-label">Unread notifications</span>
            </button>
            <button type="button" class="summary-card" (click)="tab.set('vault')">
              <span class="summary-icon"><rl-icon name="lock" [size]="16" /></span>
              <span class="summary-value">{{ vaultLabel() }}</span>
              <span class="summary-label">Password vault</span>
            </button>
            <button type="button" class="summary-card" (click)="selectTab('connections')">
              <span class="summary-icon"><rl-icon name="settings" [size]="16" /></span>
              <span class="summary-value">{{ connectionSummary() }}</span>
              <span class="summary-label">Connections</span>
            </button>
          </div>

          @if (mobileUpdate(); as update) {
            <section class="mobile-update">
              <div>
                <p class="eyebrow">Update available</p>
                <h2>Relay {{ update.latestVersion }}</h2>
                <p class="section-copy">A newer Android build is ready to install.</p>
              </div>
              <button
                type="button"
                class="text-button"
                [disabled]="updateBusy()"
                (click)="installUpdate(update)"
              >
                {{ updateBusy() ? 'Opening…' : 'Install' }}
              </button>
            </section>
          }

          <section class="section">
            <div class="section-heading">
              <h2>Recent activity</h2>
              <button type="button" class="text-button" (click)="tab.set('notifications')">
                See all
              </button>
            </div>
            @if (recentNotifications().length === 0) {
              <p class="empty-card">Nothing new yet.</p>
            } @else {
              <div class="activity-list">
                @for (notification of recentNotifications(); track notification.notificationId) {
                  <button
                    type="button"
                    class="activity-row"
                    [class.unread]="!notification.read"
                    (click)="openNotification(notification)"
                  >
                    <span class="status-dot" [attr.data-status]="notification.status"></span>
                    <span class="activity-copy">
                      <strong>{{ notification.title }}</strong>
                      <span>{{ notification.detail || 'Relay notification' }}</span>
                    </span>
                    <rl-icon name="chevron-right" [size]="16" />
                  </button>
                }
              </div>
            }
          </section>
        } @else if (tab() === 'notifications') {
          <section class="section full-section">
            <div class="section-heading">
              <div>
                <h2>Notifications</h2>
                <p class="section-copy">{{ unreadCount() }} unread</p>
              </div>
              <button
                type="button"
                class="text-button"
                [disabled]="notifications().length === 0"
                (click)="clearNotifications()"
              >
                Clear
              </button>
            </div>
            @if (notifications().length === 0) {
              <p class="empty-card">Nothing new.</p>
            } @else {
              <div class="activity-list">
                @for (notification of notifications(); track notification.notificationId) {
                  <div class="notification-swipe">
                    <span class="swipe-action" aria-hidden="true">Mark read</span>
                    <button
                      type="button"
                      class="activity-row"
                      [class.unread]="!notification.read"
                      [class.swiping]="isSwiping(notification.notificationId)"
                      [style.transform]="
                        'translateX(' + swipeOffset(notification.notificationId) + 'px)'
                      "
                      (pointerdown)="startNotificationSwipe($event, notification.notificationId)"
                      (pointermove)="moveNotificationSwipe($event)"
                      (pointerup)="endNotificationSwipe($event)"
                      (pointercancel)="cancelNotificationSwipe()"
                      (click)="openNotification(notification, $event)"
                    >
                      <span class="status-dot" [attr.data-status]="notification.status"></span>
                      <span class="activity-copy">
                        <strong>{{ notification.title }}</strong>
                        <span>{{ notification.detail || 'Relay notification' }}</span>
                      </span>
                      <rl-icon name="chevron-right" [size]="16" />
                    </button>
                  </div>
                }
              </div>
            }
          </section>
        } @else if (tab() === 'vault') {
          <section class="section full-section vault-section">
            <rl-vault />
          </section>
        } @else {
          <section class="section full-section connections-section">
            <rl-mobile-connections />
          </section>
        }
      </main>

      <nav class="mobile-nav" aria-label="Mobile navigation">
        <button
          type="button"
          [class.active]="tab() === 'dashboard'"
          (click)="tab.set('dashboard')"
          aria-label="Dashboard"
        >
          <rl-icon name="house" [size]="16" />
          <span>Home</span>
        </button>
        <button
          type="button"
          [class.active]="tab() === 'notifications'"
          (click)="tab.set('notifications')"
          aria-label="Notifications"
        >
          <span class="nav-icon">
            <rl-icon name="inbox" [size]="16" />
            @if (unreadCount() > 0) {
              <span class="nav-badge">{{ unreadCount() }}</span>
            }
          </span>
          <span>Inbox</span>
        </button>
        <button
          type="button"
          [class.active]="tab() === 'vault'"
          (click)="tab.set('vault')"
          aria-label="Password vault"
        >
          <rl-icon name="lock" [size]="16" />
          <span>Vault</span>
        </button>
      </nav>
    </div>
  `,
  styles: `
    :host {
      display: block;
      block-size: 100%;
      color: var(--text-body);
      background: var(--bg-base);
    }

    .mobile-shell {
      position: relative;
      display: flex;
      flex-direction: column;
      block-size: 100%;
      min-block-size: 100dvh;
      max-inline-size: 720px;
      margin-inline: auto;
      overflow: hidden;
      touch-action: pan-y;
    }

    .mobile-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex: none;
      padding: calc(var(--space-5) + env(safe-area-inset-top)) var(--space-5) var(--space-4);
      background: var(--bg-sunken);
      border-block-end: 1px solid var(--border-subtle);
    }

    .eyebrow {
      margin: 0;
      color: var(--text-muted);
      font-size: var(--text-11);
      font-weight: var(--weight-semibold);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    h1,
    h2,
    p {
      margin: 0;
    }

    h1 {
      margin-block-start: var(--space-1);
      font-size: var(--text-20);
      letter-spacing: -0.04em;
    }

    h2 {
      font-size: var(--text-15);
      letter-spacing: -0.02em;
    }

    .header-button,
    .text-button,
    .mobile-nav button,
    .summary-card,
    .activity-row {
      -webkit-tap-highlight-color: transparent;
    }

    .header-button {
      display: grid;
      place-items: center;
      inline-size: 44px;
      block-size: 44px;
      color: var(--text-subtle);
      border-radius: var(--radius-md);
    }

    .header-button:hover,
    .header-button:focus-visible {
      color: var(--text-strong);
      background: var(--tint-hover);
    }

    .rail-backdrop {
      position: fixed;
      z-index: 4;
      inset: 0;
      background: color-mix(in srgb, var(--bg-app) 48%, transparent);
    }

    .mobile-rail {
      position: fixed;
      z-index: 5;
      inset-block: 0;
      inset-inline-start: 0;
      display: flex;
      inline-size: min(82vw, 288px);
      flex-direction: column;
      gap: var(--space-2);
      padding: calc(var(--space-5) + env(safe-area-inset-top)) var(--space-4)
        calc(var(--space-4) + env(safe-area-inset-bottom));
      background: var(--bg-sunken);
      border-inline-end: 1px solid var(--border-subtle);
      box-shadow: var(--shadow-lg);
      animation: mobile-rail-in 160ms var(--ease-standard);
    }

    @keyframes mobile-rail-in {
      from {
        opacity: 0;
        transform: translateX(-16px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    .rail-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-block-size: 44px;
      margin-block-end: var(--space-3);
    }

    .rail-close {
      display: grid;
      place-items: center;
      inline-size: 44px;
      block-size: 44px;
      color: var(--text-subtle);
      border-radius: var(--radius-md);
    }

    .rail-close:hover,
    .rail-close:focus-visible,
    .rail-item:hover,
    .rail-item:focus-visible,
    .rail-item.active {
      background: var(--tint-hover);
    }

    .rail-item {
      display: flex;
      align-items: center;
      min-block-size: 48px;
      gap: var(--space-3);
      padding-inline: var(--space-3);
      color: var(--text-subtle);
      border-radius: var(--radius-md);
      text-align: start;
    }

    .rail-item.active {
      color: var(--primary-ink);
      background: var(--tint-selected);
    }

    .rail-badge {
      min-inline-size: 20px;
      margin-inline-start: auto;
      padding-inline: 5px;
      color: var(--primary-ink);
      background: var(--primary);
      border-radius: var(--radius-pill);
      font-size: var(--text-11);
      line-height: 20px;
      text-align: center;
    }

    .mobile-content {
      flex: 1;
      min-block-size: 0;
      overflow-y: auto;
      padding: var(--space-5);
    }

    .welcome {
      margin-block-end: var(--space-5);
    }

    .welcome-copy {
      max-inline-size: 32em;
      margin-block-start: var(--space-2);
      color: var(--text-muted);
      font-size: var(--text-14);
      line-height: 1.5;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: var(--space-3);
    }

    .summary-card,
    .empty-card,
    .activity-list {
      border: 1px solid var(--border-subtle);
      background: var(--bg-raised);
      border-radius: var(--radius-lg);
    }

    .summary-card {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      min-block-size: 136px;
      padding: var(--space-4);
      color: var(--text-body);
      text-align: start;
    }

    .summary-card:hover,
    .summary-card:focus-visible {
      border-color: var(--border-strong);
    }

    .mobile-update {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      margin-block-start: var(--space-4);
      padding: var(--space-4);
      border: 1px solid var(--primary);
      background: var(--tint-selected);
      border-radius: var(--radius-lg);
    }

    .mobile-update h2 {
      margin-block-start: var(--space-1);
    }

    .summary-icon {
      display: grid;
      place-items: center;
      inline-size: 36px;
      block-size: 36px;
      margin-block-end: var(--space-4);
      color: var(--primary-ink);
      background: var(--tint-selected);
      border-radius: var(--radius-md);
    }

    .summary-value {
      font-size: var(--text-20);
      font-weight: var(--weight-semibold);
    }

    .summary-label,
    .section-copy {
      color: var(--text-muted);
      font-size: var(--text-12);
    }

    .section {
      margin-block-start: var(--space-6);
    }

    .section-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      margin-block-end: var(--space-3);
    }

    .section-copy {
      margin-block-start: var(--space-1);
    }

    .text-button {
      min-block-size: 36px;
      padding-inline: var(--space-2);
      color: var(--primary-ink);
      font-size: var(--text-12);
      font-weight: var(--weight-medium);
    }

    .text-button:disabled {
      opacity: 0.45;
    }

    .empty-card {
      padding: var(--space-6) var(--space-4);
      color: var(--text-muted);
      text-align: center;
    }

    .activity-list {
      overflow: hidden;
    }

    .notification-swipe {
      position: relative;
      overflow: hidden;
      background: var(--tint-selected);
    }

    .swipe-action {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding-inline-end: var(--space-5);
      color: var(--primary-ink);
      font-size: var(--text-12);
      font-weight: var(--weight-medium);
    }

    .activity-row {
      display: flex;
      align-items: center;
      inline-size: 100%;
      min-block-size: 68px;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
      color: var(--text-subtle);
      text-align: start;
      border-block-end: 1px solid var(--border-subtle);
      background: var(--bg-raised);
      transition: transform 160ms var(--ease-standard);
      touch-action: pan-y;
    }

    .activity-row.swiping {
      transition: none;
    }

    .activity-row:last-child {
      border-block-end: 0;
    }

    .activity-row:hover,
    .activity-row:focus-visible {
      background: var(--tint-hover);
    }

    .activity-row.unread strong {
      color: var(--text-strong);
    }

    .status-dot {
      flex: none;
      inline-size: 8px;
      block-size: 8px;
      border-radius: var(--radius-pill);
      background: var(--status-idle);
    }

    .status-dot[data-status='done'] {
      background: var(--status-done);
    }

    .status-dot[data-status='blocked'] {
      background: var(--status-blocked);
    }

    .status-dot[data-status='waiting'] {
      background: var(--status-waiting);
    }

    .activity-copy {
      display: flex;
      flex: 1;
      min-inline-size: 0;
      flex-direction: column;
      gap: var(--space-1);
    }

    .activity-copy strong,
    .activity-copy span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .activity-copy strong {
      color: var(--text-body);
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
    }

    .activity-copy span {
      color: var(--text-muted);
      font-size: var(--text-12);
    }

    .vault-section {
      margin-inline: calc(var(--space-5) * -1);
      margin-block-start: calc(var(--space-5) * -1);
    }

    .vault-section rl-vault {
      display: block;
    }

    .connections-section {
      margin-inline: calc(var(--space-5) * -1);
      margin-block-start: calc(var(--space-5) * -1);
    }

    .mobile-nav {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      flex: none;
      padding: var(--space-2) var(--space-3) calc(var(--space-2) + env(safe-area-inset-bottom));
      border-block-start: 1px solid var(--border-subtle);
      background: var(--bg-sunken);
    }

    .mobile-nav button {
      display: flex;
      align-items: center;
      min-block-size: 52px;
      flex-direction: column;
      justify-content: center;
      gap: var(--space-1);
      color: var(--text-muted);
      font-size: var(--text-11);
      border-radius: var(--radius-md);
    }

    .mobile-nav button.active {
      color: var(--primary-ink);
      background: var(--tint-selected);
    }

    .nav-icon {
      position: relative;
      display: inline-flex;
    }

    .nav-badge {
      position: absolute;
      inset-block-start: -7px;
      inset-inline-end: -10px;
      min-inline-size: 15px;
      block-size: 15px;
      padding-inline: 3px;
      color: var(--primary-ink);
      background: var(--primary);
      border-radius: var(--radius-pill);
      font-size: 9px;
      line-height: 15px;
      text-align: center;
    }

    @media (min-width: 560px) {
      .mobile-content {
        padding-inline: var(--space-8);
      }

      .vault-section {
        margin-inline: calc(var(--space-8) * -1);
      }

      .connections-section {
        margin-inline: calc(var(--space-8) * -1);
      }
    }
  `,
})
export class Mobile {
  private readonly center = inject(NotificationCenter);
  private readonly tauri = inject(TauriBridge);
  private readonly destroyRef = inject(DestroyRef);

  private railGesture: { pointerId: number; startX: number; startY: number } | null = null;
  private notificationSwipe: {
    notificationId: string;
    pointerId: number;
    startX: number;
    startY: number;
  } | null = null;
  private suppressClickFor: string | null = null;

  protected readonly tab = signal<MobileTab>('dashboard');
  protected readonly railOpen = signal(false);
  protected readonly swipeState = signal<{ notificationId: string; offset: number } | null>(null);
  protected readonly notifications = this.center.history;
  protected readonly unreadCount = computed(
    () => this.notifications().filter((notification) => !notification.read).length,
  );
  protected readonly recentNotifications = computed(() => this.notifications().slice(0, 4));
  protected readonly vaultStatus = signal<VaultStatus>({ exists: false, unlocked: false });
  protected readonly connectionSummary = signal('Not connected');
  protected readonly mobileUpdate = signal<MobileUpdate | null>(null);
  protected readonly updateBusy = signal(false);
  protected readonly tabTitle = computed(() =>
    this.tab() === 'dashboard'
      ? 'Your dashboard'
      : this.tab() === 'notifications'
        ? 'Notifications'
        : this.tab() === 'vault'
          ? 'Password vault'
          : 'Connections',
  );
  protected readonly vaultLabel = computed(() => {
    const status = this.vaultStatus();
    return !status.exists ? 'Not set up' : status.unlocked ? 'Unlocked' : 'Locked';
  });

  constructor() {
    void this.refresh();
    void this.checkForUpdate();
    void onBackButtonPress(({ canGoBack }) => {
      if (this.railOpen()) {
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

  protected async refresh(): Promise<void> {
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

  protected async installUpdate(update: MobileUpdate): Promise<void> {
    if (this.updateBusy()) return;
    this.updateBusy.set(true);
    try {
      await this.tauri.openUrl(update.apkUrl);
    } finally {
      this.updateBusy.set(false);
    }
  }

  protected openNotification(notification: NotificationRecord, event?: MouseEvent): void {
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

  protected clearNotifications(): void {
    this.center.clearHistory();
    void this.tauri.notificationsClear();
  }

  protected toggleRail(): void {
    this.railOpen.update((open) => !open);
  }

  protected closeRail(): void {
    this.railOpen.set(false);
  }

  protected selectTab(tab: MobileTab): void {
    this.tab.set(tab);
    this.closeRail();
  }

  protected startRailGesture(event: PointerEvent): void {
    if (!event.isPrimary || event.pointerType === 'mouse') return;
    const edgeSwipe = !this.railOpen() && event.clientX <= 28;
    const closeSwipe = this.railOpen() && event.clientX > 288;
    if (!edgeSwipe && !closeSwipe) return;
    this.railGesture = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  protected moveRailGesture(event: PointerEvent): void {
    if (!this.railGesture || event.pointerId !== this.railGesture.pointerId) return;
    if (
      Math.abs(event.clientX - this.railGesture.startX) >
      Math.abs(event.clientY - this.railGesture.startY)
    ) {
      event.preventDefault();
    }
  }

  protected endRailGesture(event: PointerEvent): void {
    if (!this.railGesture || event.pointerId !== this.railGesture.pointerId) return;
    const deltaX = event.clientX - this.railGesture.startX;
    const deltaY = event.clientY - this.railGesture.startY;
    const open = mobileSwipeAction(deltaX, deltaY) === 'open-rail';
    const close = deltaX <= -72 && Math.abs(deltaX) > Math.abs(deltaY);
    if (open || close) this.railOpen.set(open);
    this.cancelRailGesture();
  }

  protected cancelRailGesture(): void {
    this.railGesture = null;
  }

  protected startNotificationSwipe(event: PointerEvent, notificationId: string): void {
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

  protected moveNotificationSwipe(event: PointerEvent): void {
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

  protected endNotificationSwipe(event: PointerEvent): void {
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

  protected cancelNotificationSwipe(): void {
    this.notificationSwipe = null;
    this.swipeState.set(null);
  }

  protected swipeOffset(notificationId: string): number {
    const state = this.swipeState();
    return state?.notificationId === notificationId ? state.offset : 0;
  }

  protected isSwiping(notificationId: string): boolean {
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
