import { Injectable, computed, signal } from '@angular/core';

import type { AppEvent, NotificationPayload, NotificationRecord } from './events';

export const DONE_GRACE_MS = 5000;

/**
 * The HUD is one small fixed-size overlay, so notifications queue rather than
 * stack: only the frontmost one shows, and a new one waits behind whatever is
 * already there. A finished notification stays on screen at 100%/"done" for
 * a short grace period rather than vanishing the instant its job completes —
 * "it worked" needs a moment to be read.
 */
@Injectable({ providedIn: 'root' })
export class NotificationCenter {
  private readonly queue = signal<readonly NotificationPayload[]>([]);
  private readonly historyState = signal<readonly NotificationRecord[]>([]);
  private readonly dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly current = computed(() => this.queue()[0] ?? null);
  readonly history = computed(() => this.historyState());

  restore(records: readonly NotificationRecord[]): void {
    this.historyState.update((current) => {
      const merged = new Map(current.map((record) => [record.notificationId, record]));
      for (const record of records) {
        if (!merged.has(record.notificationId)) merged.set(record.notificationId, record);
      }
      return [...merged.values()].sort((a, b) => b.createdAt - a.createdAt);
    });
  }

  handle(event: AppEvent): void {
    switch (event.type) {
      case 'notification':
        this.upsert(event);
        break;
      case 'notificationDone':
        this.markDone(event.jobId, event.ok);
        break;
      case 'commandsChanged':
        break;
    }
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
    this.scheduleCurrent();
  }

  private markDone(jobId: string, ok: boolean): void {
    this.queue.update((list) =>
      list.map((n) => {
        if (n.jobId !== jobId) return n;
        return ok ? { ...n, status: 'done', progress: 100 } : { ...n, status: 'blocked' };
      }),
    );
    this.historyState.update((list) =>
      list.map((n) => {
        if (n.jobId !== jobId) return n;
        return ok ? { ...n, status: 'done', progress: 100 } : { ...n, status: 'blocked' };
      }),
    );
    this.scheduleCurrent();
  }

  dismiss(notificationId: string): void {
    this.clearTimer(notificationId);
    this.queue.update((list) => list.filter((n) => n.notificationId !== notificationId));
    this.scheduleCurrent();
  }

  markRead(notificationId: string): void {
    this.historyState.update((list) =>
      list.map((record) =>
        record.notificationId === notificationId ? { ...record, read: true } : record,
      ),
    );
  }

  clearHistory(): void {
    this.historyState.set([]);
  }

  private scheduleCurrent(): void {
    const current = this.queue()[0];
    if (!current) return;

    const delay = current.status === 'done' ? (current.autoDismissMs ?? DONE_GRACE_MS) : undefined;
    if (delay === undefined) {
      this.clearTimer(current.notificationId);
      return;
    }
    if (this.dismissTimers.has(current.notificationId)) return;

    this.dismissTimers.set(
      current.notificationId,
      setTimeout(() => this.dismiss(current.notificationId), delay),
    );
  }

  private clearTimer(notificationId: string): void {
    const timer = this.dismissTimers.get(notificationId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.dismissTimers.delete(notificationId);
  }
}
