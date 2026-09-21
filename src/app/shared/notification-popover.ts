import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import type { NotificationAction, NotificationRecord } from '@core/events';
import { NotificationCenter } from '@core/notification-center';
import { TauriBridge } from '@core/tauri';

import { AppPopover, PopoverContent, PopoverTrigger } from './app-popover';
import { Icon } from './icon';

const PAGE_SIZE = 20;

@Component({
  selector: 'rl-notification-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppPopover, Icon, PopoverContent, PopoverTrigger],
  template: `
    <rl-app-popover (openChange)="onOpenChange($event)">
      <button
        type="button"
        rlPopoverTrigger
        class="trigger"
        [class.active]="popoverOpen()"
        [attr.aria-label]="unreadCount() + ' unread notifications'"
      >
        <rl-icon name="inbox" [size]="16" />
        @if (unreadCount() > 0) {
          <span class="count">{{ unreadCount() }}</span>
        }
      </button>

      <section rlPopoverContent class="popover" aria-label="Notifications">
        <header class="popover-header">
          <span class="u-caption">Notifications</span>
          <button
            type="button"
            class="clear"
            [disabled]="notifications().length === 0"
            (click)="clearAll()"
          >
            Clear all
          </button>
        </header>

        @if (notifications().length === 0) {
          <p class="empty">Nothing new.</p>
        } @else {
          <div class="cards">
            @for (notification of visibleNotifications(); track notification.notificationId) {
              <button
                type="button"
                class="card"
                [class.unread]="!notification.read"
                [attr.data-status]="notification.status"
                [attr.aria-label]="(notification.read ? 'Read: ' : 'Unread: ') + notification.title"
                (click)="openNotification(notification)"
              >
                <span class="status-dot"></span>
                <span class="copy">
                  <span class="title">{{ notification.title }}</span>
                  @if (notification.detail) {
                    <span class="u-mono detail">{{ notification.detail }}</span>
                  }
                </span>
                @if (openAction(notification); as action) {
                  <span class="action">{{ action.label }}</span>
                }
              </button>
            }
            @if (visibleNotifications().length < notifications().length) {
              <button
                #loadMoreSentinel
                type="button"
                class="loading"
                aria-label="Load more notifications"
                (click)="loadMore()"
              >
                Load more
              </button>
            }
          </div>
        }
      </section>
    </rl-app-popover>
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      inline-size: var(--control-sm);
      block-size: var(--control-sm);
    }

    .trigger {
      position: relative;
      display: grid;
      place-items: center;
      inline-size: var(--control-sm);
      block-size: var(--control-sm);
      color: var(--text-subtle);
      border-radius: var(--radius-sm);
    }

    .trigger:hover,
    .trigger.active {
      color: var(--text-strong);
      background: var(--tint-hover);
    }

    .count {
      position: absolute;
      inset-block-start: -4px;
      inset-inline-end: -5px;
      min-inline-size: 14px;
      block-size: 14px;
      padding-inline: 3px;
      color: var(--primary-ink);
      background: var(--primary);
      border-radius: var(--radius-pill);
      font-size: 9px;
      line-height: 14px;
      text-align: center;
    }

    .popover {
      inline-size: min(420px, calc(100vw - var(--space-8)));
      max-block-size: min(480px, calc(100vh - var(--titlebar-height) - var(--space-8)));
      overflow-y: auto;
      padding: var(--space-3);
    }

    .popover-header,
    .card {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    .popover-header {
      justify-content: space-between;
      padding: var(--space-2) var(--space-2) var(--space-3);
      border-block-end: 1px solid var(--border-subtle);
    }

    .clear,
    .action {
      color: var(--text-subtle);
      font-size: var(--text-12);
    }

    .clear:hover,
    .action {
      color: var(--text-body);
    }

    .clear:disabled {
      color: var(--text-subtle);
      opacity: 0.5;
    }

    .cards {
      padding-block-start: var(--space-2);
    }

    .card {
      inline-size: 100%;
      padding: var(--space-3) var(--space-2);
      color: var(--text-muted);
      text-align: start;
      border-block-end: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
    }

    .card:hover {
      background: var(--tint-hover);
    }

    .card.unread .title {
      color: var(--text-strong);
    }

    .status-dot {
      flex: none;
      inline-size: 6px;
      block-size: 6px;
      border-radius: var(--radius-pill);
      background: var(--status-idle);
    }

    .card[data-status='done'] .status-dot {
      background: var(--status-done);
    }

    .card[data-status='blocked'] .status-dot {
      background: var(--status-blocked);
    }

    .card[data-status='waiting'] .status-dot {
      background: var(--status-waiting);
    }

    .copy {
      min-inline-size: 0;
      flex: 1;
    }

    .title,
    .detail {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .title {
      font-size: var(--text-13);
    }

    .detail {
      margin-block-start: var(--space-1);
    }

    .empty,
    .loading {
      margin: 0;
      padding: var(--space-5) var(--space-2);
      color: var(--text-muted);
      text-align: center;
    }

    .loading {
      font-size: var(--text-12);
    }
  `,
})
export class NotificationPopover {
  private readonly center = inject(NotificationCenter);
  private readonly tauri = inject(TauriBridge);
  private readonly appPopover = viewChild(AppPopover);
  private readonly sentinel = viewChild<HTMLElement>('loadMoreSentinel');

  protected readonly popoverOpen = signal(false);
  protected readonly visibleCount = signal(PAGE_SIZE);
  protected readonly notifications = this.center.history;
  protected readonly unreadCount = computed(
    () => this.notifications().filter((notification) => !notification.read).length,
  );
  protected readonly visibleNotifications = computed(() =>
    this.notifications().slice(0, this.visibleCount()),
  );

  constructor() {
    effect((onCleanup) => {
      const sentinel = this.sentinel();
      if (!sentinel || typeof IntersectionObserver === 'undefined') return;

      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) this.loadMore();
      });
      observer.observe(sentinel);
      onCleanup(() => observer.disconnect());
    });
  }

  protected onOpenChange(open: boolean): void {
    if (open) this.visibleCount.set(PAGE_SIZE);
    this.popoverOpen.set(open);
  }

  protected openNotification(notification: NotificationRecord): void {
    this.center.markRead(notification.notificationId);
    void this.tauri.notificationsMarkRead([notification.notificationId]);

    const action = notification.actions?.find((item) => item.id === 'open');
    if (action?.id === 'open') void this.tauri.openUrl(action.url);
    this.appPopover()?.close();
  }

  protected openAction(notification: NotificationRecord): NotificationAction | undefined {
    return notification.actions?.find((action) => action.id === 'open');
  }

  protected clearAll(): void {
    this.center.clearHistory();
    void this.tauri.notificationsClear();
  }

  protected loadMore(): void {
    this.visibleCount.update((count) => Math.min(count + PAGE_SIZE, this.notifications().length));
  }
}
