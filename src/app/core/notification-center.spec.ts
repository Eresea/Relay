import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEvent } from './events';
import { DONE_GRACE_MS, NotificationCenter } from './notification-center';

function notification(jobId: string, overrides: Partial<AppEvent> = {}): AppEvent {
  return {
    type: 'notification',
    jobId,
    hueSource: jobId,
    title: 'Doing the thing',
    status: 'running',
    progress: 50,
    ...overrides,
  } as AppEvent;
}

describe('NotificationCenter', () => {
  let center: NotificationCenter;

  beforeEach(() => {
    vi.useFakeTimers();
    center = new NotificationCenter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with nothing to show', () => {
    expect(center.current()).toBeNull();
  });

  it('shows a notification as soon as one arrives', () => {
    center.handle(notification('job-1'));
    expect(center.current()?.jobId).toBe('job-1');
  });

  it('updates a notification with the same jobId in place rather than duplicating it', () => {
    center.handle(notification('job-1', { progress: 10 }));
    center.handle(notification('job-1', { progress: 90 }));
    expect(center.current()?.progress).toBe(90);
  });

  it('queues a second notification behind the first rather than replacing it', () => {
    center.handle(notification('job-1'));
    center.handle(notification('job-2'));
    expect(center.current()?.jobId).toBe('job-1');
  });

  it('advances to the next queued notification once the first is done and its grace period elapses', () => {
    center.handle(notification('job-1'));
    center.handle(notification('job-2'));

    center.handle({ type: 'notificationDone', jobId: 'job-1', ok: true });
    // Still showing job-1, now settled at done/100, during the grace period.
    expect(center.current()).toEqual(
      expect.objectContaining({ jobId: 'job-1', status: 'done', progress: 100 }),
    );

    vi.advanceTimersByTime(DONE_GRACE_MS + 1);
    expect(center.current()?.jobId).toBe('job-2');
  });

  it('marks a failed job blocked without inventing a progress value', () => {
    center.handle({
      type: 'notification',
      jobId: 'job-1',
      hueSource: 'job-1',
      title: 'Doing the thing',
      status: 'running',
    });
    center.handle({ type: 'notificationDone', jobId: 'job-1', ok: false });

    const current = center.current();
    expect(current?.status).toBe('blocked');
    expect(current?.progress).toBeUndefined();
  });

  it('ignores commandsChanged — no notification state to update', () => {
    center.handle({ type: 'commandsChanged' });
    expect(center.current()).toBeNull();
  });
});
