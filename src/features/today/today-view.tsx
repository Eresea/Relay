import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { hueFor, hueVar } from '@/core/entity-hue';
import type { NotificationAction, NotificationStatus } from '@/core/events';
import { NotificationCenter } from '@/core/notification-center';
import { TauriBridge } from '@/core/tauri';
import { ago } from '@/features/palette/omnibar';
import { inject } from '@/lib/inject';
import { computed, signal, useController, useSignals } from '@/lib/signals';
import { cn, vars } from '@/lib/utils';
import { Icon } from '@/shared/icon';

import { SOURCES, buildToday, type Filter, type Source, type TodayItem } from './today';
import './today.css';

const STATUS_LABEL: Record<NotificationStatus, string> = {
  running: 'Running',
  waiting: 'Needs you',
  blocked: 'Failed',
  done: 'Done',
};

/** Today's selection and filter, over the notification center the HUD also reads. */
class TodayState {
  private readonly center = inject(NotificationCenter);
  private readonly tauri = inject(TauriBridge);

  readonly filter = signal<Filter>('all');
  private readonly selectedId = signal<string | null>(null);

  readonly today = computed(() =>
    buildToday(this.center.items(), this.center.history(), this.filter()),
  );
  /** The picked item, or the first that most deserves a look. */
  readonly selected = computed(() => {
    const { needs, happening, quiet } = this.today();
    const all = [...needs, ...happening, ...quiet];
    return all.find((item) => item.id === this.selectedId()) ?? all[0];
  });

  /** Read state changes in whichever window you read in, so start from the stored copy. */
  start(): void {
    if (!this.tauri.available) return;
    void this.tauri
      .notificationsList()
      .then((records) => this.center.syncHistory(records))
      .catch(() => undefined);
  }

  select(item: TodayItem): void {
    this.selectedId.set(item.id);
    if (!item.read) this.markRead([item.id]);
  }

  runAction(action: NotificationAction, item: TodayItem): void {
    this.markRead([item.id]);
    if (action.id === 'open') void this.tauri.openUrl(action.url);
    if (action.id === 'cancel') void this.tauri.cancelJob(item.jobId);
  }

  dismiss(item: TodayItem): void {
    this.center.dismiss(item.id);
    this.markRead([item.id]);
  }

  markAllRead(): void {
    const ids = this.center.markAllRead();
    if (ids.length > 0) void this.tauri.notificationsMarkRead(ids);
  }

  clearQuiet(): void {
    this.center.clearHistory();
    void this.tauri.notificationsClear();
  }

  private markRead(ids: readonly string[]): void {
    for (const id of ids) this.center.markRead(id);
    void this.tauri.notificationsMarkRead(ids);
  }
}

const tone = (item: TodayItem) => vars({ '--entity-hue': hueVar(hueFor(item.hueSource)) });
const age = (item: TodayItem) => (item.createdAt === undefined ? 'now' : ago(item.createdAt));

/**
 * Today: everything Relay knows about, in one triage list. What waits on you
 * first, then what is happening, then the quiet updates that need nothing.
 */
export default function Today() {
  useSignals();
  const s = useController(() => new TodayState());
  const today = s.today();
  const selected = s.selected();
  const filter = s.filter();
  const sources = Object.keys(today.counts) as Source[];
  const shown = today.needs.length + today.happening.length + today.quiet.length;

  const group = (label: string, items: readonly TodayItem[], tools?: ReactNode) =>
    items.length > 0 && (
      <section className="group" aria-label={label}>
        <header className="group-head">
          <h2 className="u-caption">{label}</h2>
          {tools}
        </header>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={cn(
              'row',
              item.id === selected?.id && 'on',
              item.group === 'quiet' && 'quiet',
            )}
            aria-current={item.id === selected?.id}
            onClick={() => s.select(item)}
          >
            <span className="u-entity-tile tile" style={tone(item)}>
              <Icon name={item.icon ?? SOURCES[item.source].icon} size={14} />
            </span>
            <span className="row-title">
              {!item.read && <span className="unread" aria-label="Unread" />}
              {item.title}
            </span>
            <span className="row-meta">{age(item)}</span>
            <span className="row-detail">
              <span className="row-source">{SOURCES[item.source].label}</span>
              {item.detail && ` · ${item.detail}`}
            </span>
            {item.status === 'running' && item.progress !== undefined && (
              <span className="u-entity-track row-track" style={tone(item)}>
                <span className="u-entity-track-fill" style={{ inlineSize: `${item.progress}%` }} />
              </span>
            )}
          </button>
        ))}
      </section>
    );

  return (
    <section className="today" aria-labelledby="today-title">
      <header className="panehead">
        <h1 id="today-title">Today</h1>
        <span className="date">
          {new Date().toLocaleDateString(undefined, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          })}
        </span>
        {today.needs.length > 0 && (
          <span className="chip on">
            <span className="dot" data-status="waiting" />
            Needs you · {today.needs.length}
          </span>
        )}
      </header>

      <div className="today-body">
        <div className="triage">
          <div className="filters" role="toolbar" aria-label="Filter by source">
            <button
              type="button"
              className={cn('chip', filter === 'all' && 'on')}
              aria-pressed={filter === 'all'}
              onClick={() => s.filter.set('all')}
            >
              All · {today.total}
            </button>
            {sources.map((source) => (
              <button
                key={source}
                type="button"
                className={cn('chip', filter === source && 'on')}
                aria-pressed={filter === source}
                onClick={() => s.filter.set(source)}
              >
                <Icon name={SOURCES[source].icon} size={14} />
                {SOURCES[source].label} · {today.counts[source]}
              </button>
            ))}
          </div>

          <div className="groups">
            {shown === 0 ? (
              <p className="empty">
                Nothing yet. Jobs, agent runs and updates land here as they happen.
              </p>
            ) : (
              <>
                {group('Needs you', today.needs)}
                {group('Happening', today.happening)}
                {group(
                  'Quiet',
                  today.quiet,
                  <span className="group-tools">
                    <Button size="sm" variant="ghost" onClick={() => s.markAllRead()}>
                      Mark all read
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => s.clearQuiet()}>
                      Clear
                    </Button>
                  </span>,
                )}
              </>
            )}
          </div>
        </div>

        <article className="detail" aria-label="Selected item">
          {selected ? (
            <>
              <header className="detail-head">
                <p className="detail-source">
                  <span className="u-entity-tile tile" style={tone(selected)}>
                    <Icon name={selected.icon ?? SOURCES[selected.source].icon} size={14} />
                  </span>
                  {SOURCES[selected.source].label} · {age(selected)}
                </p>
                <h2>{selected.title}</h2>
                <span className="chip">
                  <span className="dot" data-status={selected.status} />
                  {STATUS_LABEL[selected.status]}
                  {selected.status === 'running' &&
                    selected.progress !== undefined &&
                    ` · ${selected.progress}%`}
                </span>
              </header>
              {selected.detail && <p className="detail-body">{selected.detail}</p>}
              <footer className="detail-actions">
                {selected.actions?.map((action) => (
                  <Button
                    key={action.id}
                    size="sm"
                    variant={action.id === 'open' ? 'default' : 'outline'}
                    onClick={() => s.runAction(action, selected)}
                  >
                    {action.label}
                  </Button>
                ))}
                {selected.live && selected.status !== 'running' && (
                  <Button size="sm" variant="ghost" onClick={() => s.dismiss(selected)}>
                    Dismiss
                  </Button>
                )}
              </footer>
            </>
          ) : (
            <p className="empty">Pick an item to see it here.</p>
          )}
        </article>
      </div>
    </section>
  );
}
