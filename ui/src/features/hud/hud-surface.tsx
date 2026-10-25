import { useEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { hueFor, hueVar } from '@/core/entity-hue';
import type { NotificationAction, NotificationPayload } from '@/core/events';
import { NotificationCenter } from '@/core/notification-center';
import { TauriBridge, type HudMode } from '@/core/tauri';
import { inject } from '@/lib/inject';
import { computed, effect, signal, untracked, useSignals } from '@/lib/signals';
import { vars } from '@/lib/utils';
import { Icon } from '@/shared/icon';

import { HudCard } from './hud-card';
import './hud.css';

const MAX_CARDS = 5;
const MAX_SEGMENTS = 2;
const STACK_ORDER = { running: 0, waiting: 1, blocked: 1, done: 2 } as const;

const needsYou = (n: NotificationPayload) => n.status === 'waiting' || n.status === 'blocked';
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const tone = (hueSource: string) => hueVar(hueFor(hueSource));

/**
 * What the overlay shows, derived from the notification center. One per HUD
 * window, so it lives as long as the surface does.
 */
export class HudState {
  readonly center = inject(NotificationCenter);
  private readonly tauri = inject(TauriBridge);

  readonly items = this.center.items;
  readonly expanded = this.center.expanded;
  readonly quiet = this.center.quiet;
  readonly measured = signal<{ mode: HudMode; width: number; height: number } | null>(null);

  readonly waiting = computed(() => this.items().filter(needsYou));
  private readonly calm = computed(() => this.items().filter((n) => !needsYou(n)));

  /** What is running comes first; with nothing else live, show what waits on you. */
  readonly segments = computed(() =>
    (this.calm().length > 0 ? this.calm() : this.waiting()).slice(0, MAX_SEGMENTS),
  );
  /** Live items the pill has no room for. Waiting items are counted by the badge instead. */
  readonly hiddenCount = computed(() =>
    this.calm().length > 0 ? this.calm().length - this.segments().length : 0,
  );

  private readonly ordered = computed(() =>
    [...this.items()].sort((a, b) => STACK_ORDER[a.status] - STACK_ORDER[b.status]),
  );
  readonly cards = computed(() => this.ordered().slice(0, MAX_CARDS));
  readonly overflow = computed(() => this.items().length - this.cards().length);

  readonly quietFaces = computed(() => this.quiet().slice(0, 3));
  readonly quietLabel = computed(() => plural(this.quiet().length, 'quiet update'));
  readonly summary = computed(() => {
    const counts = [
      [this.items().filter((n) => n.status === 'running').length, 'running'],
      [this.waiting().length, 'need you'],
      [this.items().filter((n) => n.status === 'done').length, 'done'],
    ] as const;
    const parts = counts.filter(([count]) => count > 0).map(([count, word]) => `${count} ${word}`);
    return parts.length > 0 ? parts.join(' · ') : 'Nothing running';
  });

  private readonly visible = computed(() => this.expanded() || this.items().length > 0);

  /** Starts the window effects; returns their disposer. */
  start(): () => void {
    // The core shows the window when a notification arrives, because it is the
    // only side that knows one is about to exist. Everything after that — its
    // size, its anchor, taking it off screen — follows what is drawn.
    const layout = effect(() => {
      if (!this.visible()) {
        void this.tauri.runCoreCommand({ id: 'hide_hud' });
        return;
      }
      const size = this.measured();
      if (size) void this.tauri.hudLayout(size.mode, size.width, size.height);
    });
    // Read state changes in whichever window you read in. Re-read the stored
    // copy each time the overlay comes back, so the quiet count is true.
    const sync = effect(() => {
      if (this.visible()) untracked(() => void this.syncHistory());
    });
    return () => {
      layout();
      sync();
    };
  }

  toggle(): void {
    this.center.toggleExpanded();
  }

  /** Dismissing or acting on a card is reading it: it must not come back as quiet. */
  dismiss(notificationId: string): void {
    this.center.dismiss(notificationId);
    this.markRead([notificationId]);
  }

  runAction(action: NotificationAction, n: NotificationPayload): void {
    this.dismiss(n.notificationId);
    if (action.id === 'open') void this.tauri.openUrl(action.url);
    if (action.id === 'cancel') void this.tauri.cancelJob(n.jobId);
  }

  markQuietRead(): void {
    this.markRead(this.quiet().map((record) => record.notificationId));
  }

  openRelay(): void {
    this.center.toggleExpanded();
    void this.tauri.runCoreCommand({ id: 'open_main' });
  }

  private markRead(ids: readonly string[]): void {
    for (const id of ids) this.center.markRead(id);
    void this.tauri.notificationsMarkRead(ids);
  }

  private async syncHistory(): Promise<void> {
    if (!this.tauri.available) return;
    this.center.syncHistory(await this.tauri.notificationsList());
  }
}

/**
 * The attention overlay. At rest it is a one-line pill: what is running, how
 * many quiet updates arrived, how many things wait on you. Clicking it, or the
 * attention shortcut, opens the stack: one card per live item, the ones that
 * need you carrying their actions.
 *
 * The surface measures itself and asks the core for a window that fits, so the
 * transparent window never covers more of the desktop than the glass does.
 */
export default function HudSurface() {
  useSignals();
  const hud = inject(HudState);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => hud.start(), [hud]);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      hud.measured.set({
        mode: hud.expanded() ? 'stack' : 'pill',
        width: Math.ceil(width),
        height: Math.ceil(height),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hud]);

  const items = hud.items();
  const quiet = hud.quiet();
  const waiting = hud.waiting();

  return (
    <div className="hud-surface">
      <div className="frame" ref={frame}>
        {hud.expanded() ? (
          <section className="stack" aria-label="Activity">
            <div className="summary u-glass u-chrome">
              {quiet.length > 0 ? (
                <>
                  <span className="faces">
                    {hud.quietFaces().map((record) => (
                      <span
                        key={record.notificationId}
                        className="u-entity-tile face"
                        style={vars({ '--entity-hue': tone(record.hueSource) })}
                      >
                        <Icon name={record.icon ?? 'inbox'} size={14} />
                      </span>
                    ))}
                  </span>
                  <span className="summary-text">{hud.quietLabel()}</span>
                  <Button size="sm" variant="ghost" onClick={() => hud.markQuietRead()}>
                    Mark read
                  </Button>
                </>
              ) : (
                <span className="summary-text">{hud.summary()}</span>
              )}
              <Button size="sm" variant="ghost" onClick={() => hud.openRelay()}>
                Open Relay
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Collapse"
                onClick={() => hud.toggle()}
              >
                <Icon name="minus" size={14} />
              </Button>
            </div>

            {hud.cards().map((n) => (
              <HudCard
                key={n.notificationId}
                title={n.title}
                detail={n.detail}
                icon={n.icon}
                hue={hueFor(n.hueSource)}
                status={n.status}
                progress={n.progress}
                actions={n.actions}
                onDismiss={() => hud.dismiss(n.notificationId)}
                onAction={(action) => hud.runAction(action, n)}
              />
            ))}
            {hud.overflow() > 0 && <p className="more">{hud.overflow()} more in Relay</p>}
          </section>
        ) : (
          items.length > 0 && (
            <button
              type="button"
              className="pill u-glass u-chrome"
              aria-label={`Activity: ${hud.summary()}. Show details`}
              onClick={() => hud.toggle()}
            >
              {hud.segments().map((n) => {
                const ring = n.status === 'running' && n.progress !== undefined;
                return (
                  <span key={n.notificationId} className="seg">
                    {ring ? (
                      <span
                        className="ring"
                        style={vars({
                          '--entity-hue': tone(n.hueSource),
                          '--progress': n.progress ?? 0,
                        })}
                      />
                    ) : (
                      <span className="dot" data-status={n.status} />
                    )}
                    <span className="seg-title">{n.title}</span>
                    {ring && <span className="num">{n.progress}%</span>}
                  </span>
                );
              })}
              {hud.hiddenCount() > 0 && <span className="seg num">+{hud.hiddenCount()}</span>}
              {quiet.length > 0 && (
                <span className="seg quiet">
                  <Icon name="inbox" size={14} />
                  <span className="num">{quiet.length}</span>
                </span>
              )}
              {waiting.length > 0 && <span className="badge">{waiting.length}</span>}
            </button>
          )
        )}
      </div>
    </div>
  );
}
