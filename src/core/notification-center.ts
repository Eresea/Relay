import { computed, signal } from '@/lib/signals';

import type { AppEvent, NotificationPayload, NotificationRecord } from './events';

export const DONE_GRACE_MS = 5000;

/**
 * Live notifications for the attention overlay, plus the history behind them.
 *
 * Every live item is on screen at once — as a segment of the pill or a card in
 * the stack — so each finished item gets its own grace period from the moment
 * it finishes: "it worked" needs a moment to be read, and nothing ahead of it
 * should hold it on screen longer. Failed and waiting items stay until
 * dismissed, because they are the ones that need you.
 */
export class NotificationCenter {
  private readonly queue = signal<readonly NotificationPayload[]>([]);
  private readonly historyState = signal<readonly NotificationRecord[]>([]);
  private readonly expandedState = signal(false);
  private readonly dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly items = this.queue.asReadonly();
  readonly history = this.historyState.asReadonly();
  /** The stack is open. Toggled by the attention shortcut or by clicking the pill. */
  readonly expanded = this.expandedState.asReadonly();
  /** Unread history that is no longer live: it happened, nothing waits on it. */
  readonly quiet = computed(() => {
    const live = new Set(this.queue().map((n) => n.notificationId));
    return this.historyState().filter((r) => !r.read && !live.has(r.notificationId));
  });

  restore(records: readonly NotificationRecord[]): void {
    this.historyState.update((current) => {
      const merged = new Map(current.map((record) => [record.notificationId, record]));
      for (const record of records) {
        if (!merged.has(record.notificationId)) merged.set(record.notificationId, record);
      }
      return [...merged.values()].sort((a, b) => b.createdAt - a.createdAt);
    });
  }

  /**
   * Replaces history with the persisted copy. Each webview holds its own
   * history, and read state changes in whichever window you read in, so the
   * overlay re-reads the stored truth before it counts what is unread.
   */
  syncHistory(records: readonly NotificationRecord[]): void {
    this.historyState.set([...records].sort((a, b) => b.createdAt - a.createdAt));
  }

  handle(event: AppEvent): void {
    switch (event.type) {
      case 'notification':
        this.upsert(event);
        break;
      case 'notificationDone':
        this.markDone(event.jobId, event.ok);
        break;
      case 'attentionToggleRequested':
        this.toggleExpanded();
        break;
    }
  }

  toggleExpanded(): void {
    this.expandedState.update((expanded) => !expanded);
  }

  private upsert(notification: NotificationPayload): void {
    const previous = this.historyState().find(
      (record) => record.notificationId === notification.notificationId,
    );
    const record: NotificationRecord = {
      ...notification,
      read: previous?.read ?? false,
      createdAt: previous?.createdAt ?? Date.now(),
    };
    this.queue.update((list) => {
      const index = list.findIndex((n) => n.notificationId === notification.notificationId);
      if (index === -1) return [...list, notification];
      const next = [...list];
      next[index] = notification;
      return next;
    });
    this.historyState.update((list) => [
      record,
      ...list.filter((n) => n.notificationId !== notification.notificationId),
    ]);
    this.scheduleDone();
  }

  private markDone(jobId: string, ok: boolean): void {
    const settle = <T extends NotificationPayload>(n: T): T =>
      n.jobId !== jobId
        ? n
        : ok
          ? { ...n, status: 'done', progress: 100 }
          : { ...n, status: 'blocked' };
    this.queue.update((list) => list.map(settle));
    this.historyState.update((list) => list.map(settle));
    this.scheduleDone();
  }

  dismiss(notificationId: string): void {
    this.clearTimer(notificationId);
    this.queue.update((list) => list.filter((n) => n.notificationId !== notificationId));
  }

  markRead(notificationId: string): void {
    this.historyState.update((list) =>
      list.map((record) =>
        record.notificationId === notificationId ? { ...record, read: true } : record,
      ),
    );
  }

  markAllRead(): readonly string[] {
    const unreadIds = this.historyState()
      .filter((record) => !record.read)
      .map((record) => record.notificationId);
    this.historyState.update((list) => list.map((record) => ({ ...record, read: true })));
    return unreadIds;
  }

  clearHistory(): void {
    this.historyState.set([]);
  }

  /** Starts a grace timer for every finished item that does not have one yet. */
  private scheduleDone(): void {
    for (const n of this.queue()) {
      if (n.status !== 'done') {
        this.clearTimer(n.notificationId);
        continue;
      }
      if (this.dismissTimers.has(n.notificationId)) continue;
      this.dismissTimers.set(
        n.notificationId,
        setTimeout(() => this.dismiss(n.notificationId), n.autoDismissMs ?? DONE_GRACE_MS),
      );
    }
  }

  private clearTimer(notificationId: string): void {
    const timer = this.dismissTimers.get(notificationId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.dismissTimers.delete(notificationId);
  }
}
