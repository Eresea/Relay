import { Injectable, computed, signal } from '@angular/core';

import type { AppEvent, NotificationPayload } from './events';

export const DONE_GRACE_MS = 1200;

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
  private readonly dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly current = computed(() => this.queue()[0] ?? null);

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
    this.queue.update((list) => {
      const index = list.findIndex((n) => n.notificationId === notification.notificationId);
      if (index === -1) return [...list, notification];
      const next = [...list];
      next[index] = notification;
      return next;
    });
    this.scheduleCurrent();
  }

  private markDone(jobId: string, ok: boolean): void {
    this.queue.update((list) =>
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
