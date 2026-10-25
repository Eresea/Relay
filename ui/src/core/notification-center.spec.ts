import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEvent, NotificationRecord } from './events';
import { DONE_GRACE_MS, NotificationCenter } from './notification-center';

function notification(jobId: string, overrides: Partial<AppEvent> = {}): AppEvent {
  return {
    type: 'notification',
    notificationId: jobId,
    jobId,
    hueSource: jobId,
    title: 'Doing the thing',
    status: 'running',
    progress: 50,
    ...overrides,
  } as AppEvent;
}

function record(notificationId: string, read: boolean, createdAt = 1): NotificationRecord {
  return {
    notificationId,
    jobId: notificationId,
    hueSource: notificationId,
    title: 'Something happened',
    status: 'done',
    read,
    createdAt,
  };
}

describe('NotificationCenter', () => {
  let center: NotificationCenter;
  const ids = () => center.items().map((n) => n.notificationId);

  beforeEach(() => {
    vi.useFakeTimers();
    center = new NotificationCenter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with nothing to show', () => {
    expect(center.items()).toEqual([]);
    expect(center.expanded()).toBe(false);
  });

  it('shows a notification as soon as one arrives', () => {
    center.handle(notification('job-1'));
    expect(ids()).toEqual(['job-1']);
  });

  it('updates a notification with the same id in place rather than duplicating it', () => {
    center.handle(notification('job-1', { progress: 10 }));
    center.handle(notification('job-1', { progress: 90 }));
    expect(center.items()).toEqual([expect.objectContaining({ progress: 90 })]);
  });

  it('keeps every live notification, in arrival order', () => {
    center.handle(notification('job-1'));
    center.handle(notification('job-2'));
    expect(ids()).toEqual(['job-1', 'job-2']);
  });

  it('dismisses by notificationId', () => {
    center.handle(notification('job-1'));
    center.handle(notification('job-2'));

    center.dismiss('job-1');

    expect(ids()).toEqual(['job-2']);
  });

  it('gives every completed notification its own grace period', () => {
    center.handle(notification('job-1', { status: 'done', autoDismissMs: 500 }));
    center.handle(notification('job-2', { status: 'done', autoDismissMs: 500 }));

    vi.advanceTimersByTime(499);
    expect(ids()).toEqual(['job-1', 'job-2']);
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual([]);
  });

  it('does not hold a finished notification behind running work', () => {
    center.handle(notification('job-1'));
    center.handle(notification('job-2', { status: 'done', autoDismissMs: 500 }));

    vi.advanceTimersByTime(500);

    expect(ids()).toEqual(['job-1']);
  });

  it('settles a finished job at done and 100, then drops it after the grace period', () => {
    center.handle(notification('job-1'));
    center.handle(notification('job-2'));

    center.handle({ type: 'notificationDone', jobId: 'job-1', ok: true });
    expect(center.items()[0]).toEqual(
      expect.objectContaining({ jobId: 'job-1', status: 'done', progress: 100 }),
    );

    vi.advanceTimersByTime(DONE_GRACE_MS + 1);
    expect(ids()).toEqual(['job-2']);
  });

  it('keeps a failed job live as blocked until it is dismissed', () => {
    center.handle(notification('job-1'));
    center.handle({ type: 'notificationDone', jobId: 'job-1', ok: false });

    vi.advanceTimersByTime(DONE_GRACE_MS + 1);

    expect(center.items()).toEqual([
      expect.objectContaining({ jobId: 'job-1', status: 'blocked' }),
    ]);
  });

  it('marks a failed job blocked without inventing a progress value', () => {
    center.handle({
      type: 'notification',
      notificationId: 'job-1',
      jobId: 'job-1',
      hueSource: 'job-1',
      title: 'Doing the thing',
      status: 'running',
    });
    center.handle({ type: 'notificationDone', jobId: 'job-1', ok: false });

    expect(center.items()[0]?.progress).toBeUndefined();
  });

  it('keeps separate notifications from one long-running job', () => {
    center.handle(notification('gmail-job', { notificationId: 'mail-1' }));
    center.handle(notification('gmail-job', { notificationId: 'mail-2' }));

    expect(ids()).toEqual(['mail-1', 'mail-2']);
  });

  it('keeps completed notifications in history after the overlay drops them', () => {
    center.handle(notification('job-1', { status: 'done' }));
    vi.advanceTimersByTime(DONE_GRACE_MS + 1);

    expect(center.items()).toEqual([]);
    expect(center.history()[0]).toEqual(
      expect.objectContaining({ jobId: 'job-1', status: 'done' }),
    );
  });

  it('counts unread history that is no longer live as quiet', () => {
    center.handle(notification('job-1', { status: 'done', autoDismissMs: 100 }));
    center.handle(notification('job-2'));
    expect(center.quiet()).toEqual([]);

    vi.advanceTimersByTime(100);

    expect(center.quiet().map((r) => r.notificationId)).toEqual(['job-1']);
    center.markRead('job-1');
    expect(center.quiet()).toEqual([]);
  });

  it('replaces history with the persisted copy so read state from other windows applies', () => {
    center.handle(notification('job-1', { status: 'done', autoDismissMs: 100 }));
    vi.advanceTimersByTime(100);

    center.syncHistory([record('job-1', true, 1), record('job-0', false, 2)]);

    expect(center.history().map((r) => r.notificationId)).toEqual(['job-0', 'job-1']);
    expect(center.quiet().map((r) => r.notificationId)).toEqual(['job-0']);
  });

  it('marks a history record as read without removing it', () => {
    center.handle(notification('job-1'));

    center.markRead('job-1');

    expect(center.history()[0]).toEqual(
      expect.objectContaining({ notificationId: 'job-1', read: true }),
    );
  });

  it('marks every unread history record as read and returns their ids', () => {
    center.handle(notification('job-1'));
    center.handle(notification('job-2'));
    center.markRead('job-2');

    expect(center.markAllRead()).toEqual(['job-1']);
    expect(center.history().every((r) => r.read)).toBe(true);
  });

  it('opens and closes the stack on the attention shortcut', () => {
    center.handle({ type: 'attentionToggleRequested' });
    expect(center.expanded()).toBe(true);
    center.handle({ type: 'attentionToggleRequested' });
    expect(center.expanded()).toBe(false);
  });

  it('ignores commandsChanged', () => {
    center.handle({ type: 'commandsChanged' });
    expect(center.items()).toEqual([]);
  });
});
