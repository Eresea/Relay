import { describe, expect, it } from 'vitest';

import type { NotificationPayload, NotificationRecord } from '@/core/events';

import { QUIET_LIMIT, buildToday, sourceOf } from './today';

function live(id: string, overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    notificationId: id,
    jobId: id,
    hueSource: 'relay',
    title: id,
    status: 'running',
    ...overrides,
  };
}

function record(id: string, createdAt: number, overrides: Partial<NotificationRecord> = {}) {
  return {
    ...live(id, { status: 'done' }),
    read: false,
    createdAt,
    ...overrides,
  };
}

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

describe('sourceOf', () => {
  it('reads the producer from the hue source', () => {
    expect(sourceOf('codex')).toBe('agents');
    expect(sourceOf('claude')).toBe('claude');
    expect(sourceOf('github')).toBe('github');
    expect(sourceOf('gmail')).toBe('mail');
    expect(sourceOf('F:\\Code\\Apps\\Relay')).toBe('scripts');
    expect(sourceOf('/home/nils/leaf')).toBe('scripts');
    expect(sourceOf('something-else')).toBe('relay');
  });
});

describe('buildToday', () => {
  it('splits live items into needs-you and happening, and history into quiet', () => {
    const today = buildToday(
      [
        live('build'),
        live('ask', { status: 'waiting' }),
        live('failed', { status: 'blocked' }),
        live('merged', { status: 'done' }),
      ],
      [record('mail', 5), record('old', 1), record('build', 9)],
    );

    expect(ids(today.needs)).toEqual(['ask', 'failed']);
    expect(ids(today.happening)).toEqual(['build', 'merged']);
    // A live item is not repeated in quiet, and quiet is newest first.
    expect(ids(today.quiet)).toEqual(['mail', 'old']);
  });

  it('takes a live item’s age and read state from its history record', () => {
    const today = buildToday([live('build')], [record('build', 42, { read: true })]);
    expect(today.happening[0]).toEqual(expect.objectContaining({ createdAt: 42, read: true }));
  });

  it('filters every group to one source but counts all of them', () => {
    const today = buildToday(
      [
        live('agent', { hueSource: 'codex' }),
        live('pr', { hueSource: 'github', status: 'waiting' }),
      ],
      [record('mail', 3, { hueSource: 'gmail' }), record('run', 2, { hueSource: 'codex' })],
      'agents',
    );

    expect(ids(today.needs)).toEqual([]);
    expect(ids(today.happening)).toEqual(['agent']);
    expect(ids(today.quiet)).toEqual(['run']);
    expect(today.counts).toEqual({ agents: 2, github: 1, mail: 1 });
    expect(today.total).toBe(4);
  });

  it('leaves out items from sources whose module is off', () => {
    const today = buildToday(
      [live('agent', { hueSource: 'codex' }), live('pr', { hueSource: 'github' })],
      [record('mail', 3, { hueSource: 'gmail' })],
      'all',
      (source) => source !== 'mail',
    );
    expect(ids(today.happening)).toEqual(['agent', 'pr']);
    expect(today.quiet).toEqual([]);
    expect(today.counts).toEqual({ agents: 1, github: 1 });
  });

  it('keeps quiet history to a catch-up, not an archive', () => {
    const history = Array.from({ length: QUIET_LIMIT + 5 }, (_, i) => record(`r${i}`, i));
    expect(buildToday([], history).quiet).toHaveLength(QUIET_LIMIT);
  });
});
