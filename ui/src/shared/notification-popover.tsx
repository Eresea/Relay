import { useEffect, useRef, useState } from 'react';

import type { NotificationRecord } from '@/core/events';
import { NotificationCenter } from '@/core/notification-center';
import { TauriBridge } from '@/core/tauri';
import { inject } from '@/lib/inject';
import { signal, useSignals } from '@/lib/signals';
import { cn } from '@/lib/utils';

import { AppPopover, PopoverContent, PopoverTrigger } from './app-popover';
import { Icon } from './icon';
import './notification-popover.css';

const PAGE_SIZE = 20;

/** How many history rows the open popover shows; grows as you scroll. */
const visibleCount = signal(PAGE_SIZE);

/** The titlebar inbox: notification history, newest first, read state kept in the core. */
export function NotificationPopover() {
  useSignals();
  const center = inject(NotificationCenter);
  const tauri = inject(TauriBridge);
  const [open, setOpen] = useState(false);
  const sentinel = useRef<HTMLButtonElement>(null);

  const notifications = center.history();
  const unread = notifications.filter((n) => !n.read).length;
  const visible = notifications.slice(0, visibleCount());
  const hasMore = visible.length < notifications.length;

  const loadMore = () =>
    visibleCount.update((count) => Math.min(count + PAGE_SIZE, notifications.length));

  // Loads the next page when the "Load more" row scrolls into view.
  useEffect(() => {
    const element = sentinel.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        visibleCount.update((count) => count + PAGE_SIZE);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, hasMore]);

  const onOpenChange = (next: boolean) => {
    if (next) visibleCount.set(PAGE_SIZE);
    setOpen(next);
  };

  const openNotification = (notification: NotificationRecord) => {
    center.markRead(notification.notificationId);
    void tauri.notificationsMarkRead([notification.notificationId]);
    const action = notification.actions?.find((item) => item.id === 'open');
    if (action?.id === 'open') void tauri.openUrl(action.url);
    setOpen(false);
  };

  const markAllRead = () => {
    const ids = center.markAllRead();
    if (ids.length > 0) void tauri.notificationsMarkRead(ids);
  };

  const clearAll = () => {
    center.clearHistory();
    void tauri.notificationsClear();
  };

  return (
    <div className="notification-popover">
      <AppPopover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger>
          <button
            type="button"
            className={cn('trigger', open && 'active')}
            aria-label={`${unread} unread notifications`}
          >
            <Icon name="inbox" size={16} />
            {unread > 0 && <span className="count">{unread}</span>}
          </button>
        </PopoverTrigger>

        <PopoverContent className="popover" aria-label="Notifications">
          <header className="popover-header">
            <span className="u-caption">Notifications</span>
            <div className="header-actions">
              <button type="button" className="clear" disabled={unread === 0} onClick={markAllRead}>
                Mark all read
              </button>
              <button
                type="button"
                className="clear"
                disabled={notifications.length === 0}
                onClick={clearAll}
              >
                Clear all
              </button>
            </div>
          </header>

          {notifications.length === 0 ? (
            <p className="empty">Nothing new.</p>
          ) : (
            <div className="cards">
              {visible.map((notification) => {
                const action = notification.actions?.find((a) => a.id === 'open');
                return (
                  <button
                    key={notification.notificationId}
                    type="button"
                    className={cn('card', !notification.read && 'unread')}
                    data-status={notification.status}
                    aria-label={(notification.read ? 'Read: ' : 'Unread: ') + notification.title}
                    onClick={() => openNotification(notification)}
                  >
                    <span className="status-dot" />
                    <span className="copy">
                      <span className="title">{notification.title}</span>
                      {notification.detail && (
                        <span className="u-mono detail">{notification.detail}</span>
                      )}
                    </span>
                    {action && <span className="action">{action.label}</span>}
                  </button>
                );
              })}
              {hasMore && (
                <button
                  ref={sentinel}
                  type="button"
                  className="loading"
                  aria-label="Load more notifications"
                  onClick={loadMore}
                >
                  Load more
                </button>
              )}
            </div>
          )}
        </PopoverContent>
      </AppPopover>
    </div>
  );
}
