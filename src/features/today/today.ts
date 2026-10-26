import type { NotificationPayload, NotificationRecord, NotificationStatus } from '@/core/events';

/** Where an item came from, read from the `hueSource` its producer set. */
export type Source = 'agents' | 'claude' | 'github' | 'mail' | 'scripts' | 'relay';

/** Each source and the module that produces it (an id in core/modules.ts). */
export const SOURCES: Readonly<Record<Source, { label: string; icon: string; module: string }>> = {
  agents: { label: 'Codex', icon: 'sparkles', module: 'codex' },
  claude: { label: 'Claude', icon: 'bot', module: 'claude' },
  github: { label: 'GitHub', icon: 'git-pull-request', module: 'github' },
  mail: { label: 'Mail', icon: 'inbox', module: 'gmail' },
  scripts: { label: 'Scripts', icon: 'terminal', module: 'projects' },
  relay: { label: 'Relay', icon: 'circle', module: 'today' },
};

export function sourceOf(hueSource: string): Source {
  if (hueSource === 'codex') return 'agents';
  if (hueSource === 'claude') return 'claude';
  if (hueSource === 'github') return 'github';
  if (hueSource === 'gmail') return 'mail';
  // Script jobs are coloured by their workspace: a path.
  if (/[\\/]/.test(hueSource)) return 'scripts';
  return 'relay';
}

export type Group = 'needs' | 'happening' | 'quiet';

/** One row of Today: a live notification or a history record, never both. */
export interface TodayItem {
  readonly id: string;
  readonly group: Group;
  readonly source: Source;
  readonly status: NotificationStatus;
  readonly title: string;
  readonly detail: string | undefined;
  readonly icon: string | undefined;
  readonly hueSource: string;
  readonly jobId: string;
  readonly progress: number | undefined;
  readonly actions: NotificationPayload['actions'];
  /** Undefined for a live item that has not reached history yet. */
  readonly createdAt: number | undefined;
  readonly read: boolean;
  readonly live: boolean;
}

export type Filter = 'all' | Source;

export interface Today {
  readonly needs: readonly TodayItem[];
  readonly happening: readonly TodayItem[];
  readonly quiet: readonly TodayItem[];
  /** Items per source across all three groups, for the filter chips. */
  readonly counts: Readonly<Partial<Record<Source, number>>>;
  readonly total: number;
}

/** Quiet history worth showing: enough to catch up, not an archive. */
export const QUIET_LIMIT = 40;

const needsYou = (status: NotificationStatus) => status === 'waiting' || status === 'blocked';

/**
 * Sorts everything Relay knows about into three groups: what waits on you
 * (live, waiting or failed), what is happening (live, running or just done),
 * and what is quiet (history that is no longer live). Live items keep their
 * arrival order; quiet items are newest first.
 */
export function buildToday(
  live: readonly NotificationPayload[],
  history: readonly NotificationRecord[],
  filter: Filter = 'all',
  /** Sources whose module is on; an off module's items disappear, counts included. */
  isOn: (source: Source) => boolean = () => true,
): Today {
  const records = new Map(history.map((r) => [r.notificationId, r]));
  const liveIds = new Set(live.map((n) => n.notificationId));

  const fromLive = live.map((n): TodayItem => {
    const record = records.get(n.notificationId);
    return {
      id: n.notificationId,
      group: needsYou(n.status) ? 'needs' : 'happening',
      source: sourceOf(n.hueSource),
      status: n.status,
      title: n.title,
      detail: n.detail,
      icon: n.icon,
      hueSource: n.hueSource,
      jobId: n.jobId,
      progress: n.progress,
      actions: n.actions,
      createdAt: record?.createdAt,
      read: record?.read ?? false,
      live: true,
    };
  });
  const fromHistory = history
    .filter((r) => !liveIds.has(r.notificationId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, QUIET_LIMIT)
    .map((r): TodayItem => ({
      id: r.notificationId,
      group: 'quiet',
      source: sourceOf(r.hueSource),
      status: r.status,
      title: r.title,
      detail: r.detail,
      icon: r.icon,
      hueSource: r.hueSource,
      jobId: r.jobId,
      progress: undefined,
      actions: r.actions,
      createdAt: r.createdAt,
      read: r.read,
      live: false,
    }));

  const all = [...fromLive, ...fromHistory].filter((item) => isOn(item.source));
  const counts: Partial<Record<Source, number>> = {};
  for (const item of all) counts[item.source] = (counts[item.source] ?? 0) + 1;
  const shown = filter === 'all' ? all : all.filter((item) => item.source === filter);

  return {
    needs: shown.filter((item) => item.group === 'needs'),
    happening: shown.filter((item) => item.group === 'happening'),
    quiet: shown.filter((item) => item.group === 'quiet'),
    counts,
    total: all.length,
  };
}
