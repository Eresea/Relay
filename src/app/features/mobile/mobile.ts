import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { NotificationCenter } from '@core/notification-center';
import type { NotificationRecord } from '@core/events';
import { TauriBridge, type VaultStatus } from '@core/tauri';
import { Vault } from '@features/vault/vault';
import { Icon } from '@shared/icon';

type MobileTab = 'dashboard' | 'notifications' | 'vault';

@Component({
  selector: 'rl-mobile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Vault],
  template: `
    <div class="mobile-shell">
      <header class="mobile-header">
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
          </div>

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
        } @else {
          <section class="section full-section vault-section">
            <rl-vault />
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
      display: flex;
      flex-direction: column;
      block-size: 100%;
      min-block-size: 100dvh;
      max-inline-size: 720px;
      margin-inline: auto;
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
      grid-template-columns: repeat(2, minmax(0, 1fr));
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
    }
  `,
})
export class Mobile {
  private readonly center = inject(NotificationCenter);
  private readonly tauri = inject(TauriBridge);

  protected readonly tab = signal<MobileTab>('dashboard');
  protected readonly notifications = this.center.history;
  protected readonly unreadCount = computed(
    () => this.notifications().filter((notification) => !notification.read).length,
  );
  protected readonly recentNotifications = computed(() => this.notifications().slice(0, 4));
  protected readonly vaultStatus = signal<VaultStatus>({ exists: false, unlocked: false });
  protected readonly tabTitle = computed(() =>
    this.tab() === 'dashboard'
      ? 'Your dashboard'
      : this.tab() === 'notifications'
        ? 'Notifications'
        : 'Password vault',
  );
  protected readonly vaultLabel = computed(() => {
    const status = this.vaultStatus();
    return !status.exists ? 'Not set up' : status.unlocked ? 'Unlocked' : 'Locked';
  });

  constructor() {
    void this.refresh();
  }

  protected async refresh(): Promise<void> {
    this.vaultStatus.set(await this.tauri.vaultStatus());
  }

  protected openNotification(notification: NotificationRecord): void {
    this.center.markRead(notification.notificationId);
    void this.tauri.notificationsMarkRead([notification.notificationId]);

    const action = notification.actions?.find((item) => item.id === 'open');
    if (action?.id === 'open') void this.tauri.openUrl(action.url);
  }

  protected clearNotifications(): void {
    this.center.clearHistory();
    void this.tauri.notificationsClear();
  }
}
