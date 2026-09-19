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
      const index = list.findIndex((n) => n.jobId === notification.jobId);
      if (index === -1) return [...list, notification];
      const next = [...list];
      next[index] = notification;
      return next;
    });
  }

  private markDone(jobId: string, ok: boolean): void {
    this.queue.update((list) =>
      list.map((n) => {
        if (n.jobId !== jobId) return n;
        return ok ? { ...n, status: 'done', progress: 100 } : { ...n, status: 'blocked' };
      }),
    );

    setTimeout(() => {
      this.queue.update((list) => list.filter((n) => n.jobId !== jobId));
    }, DONE_GRACE_MS);
  }
}
