import { useEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { hueFor, hueVar } from '@/core/entity-hue';
import type { NotificationAction, NotificationPayload } from '@/core/events';
import { NotificationCenter } from '@/core/notification-center';
import { TauriBridge, type HudSide } from '@/core/tauri';
import { inject } from '@/lib/inject';
import { computed, effect, signal, untracked, useSignals } from '@/lib/signals';
import { vars } from '@/lib/utils';
import { Icon } from '@/shared/icon';
import { InlineText } from '@/shared/inline-text';

import { HudCard } from './hud-card';
import './hud.css';

const MAX_CARDS = 5;
const MAX_SEGMENTS = 2;
/** What waits on you leads, then what is moving, then what just finished. */
const STACK_ORDER = { waiting: 0, blocked: 0, running: 1, done: 2 } as const;

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
  readonly measured = signal<{ width: number; height: number } | null>(null);
  readonly unlocked = signal(false);
  /** Which way the window grows from its node; the core decides from where the node sits. */
  readonly side = signal<HudSide>('left');

  readonly waiting = computed(() => this.items().filter(needsYou));
  private readonly calm = computed(() => this.items().filter((n) => !needsYou(n)));

  /**
   * The pill leads with what waits on you, since that is why to look at it,
   * then fills with what is running.
   */
  readonly segments = computed(() =>
    [...this.waiting().slice(0, 1), ...this.calm()].slice(0, MAX_SEGMENTS),
  );
  /** Live items the pill has no room for. */
  readonly hiddenCount = computed(() => this.items().length - this.segments().length);

  private readonly ordered = computed(() =>
    [...this.items()].sort((a, b) => STACK_ORDER[a.status] - STACK_ORDER[b.status]),
  );
  readonly cards = computed(() => this.ordered().slice(0, MAX_CARDS));
  readonly overflow = computed(() => this.items().length - this.cards().length);

  readonly quietFaces = computed(() => this.quiet().slice(0, 3));
  readonly quietLabel = computed(() => plural(this.quiet().length, 'quiet update'));
  readonly summary = computed(() => {
    const waiting = this.waiting().length;
    const counts = [
      [waiting, waiting === 1 ? 'needs you' : 'need you'],
      [this.items().filter((n) => n.status === 'running').length, 'running'],
      [this.items().filter((n) => n.status === 'done').length, 'done'],
    ] as const;
    const parts = counts.filter(([count]) => count > 0).map(([count, word]) => `${count} ${word}`);
    return parts.length > 0 ? parts.join(' · ') : 'Nothing running';
  });

  /** Starts the window effects; returns their disposer. */
  start(): () => void {
    // The window never leaves: at rest it is a small indicator, so its size and
    // anchor follow what is drawn.
    const layout = effect(() => {
      const size = this.measured();
      if (size) {
        void this.tauri
          .hudLayout(size.width, size.height)
          .then((side) => side && this.side.set(side));
      }
    });
    // Read state changes in whichever window you read in. Re-read the stored
    // copy whenever the overlay changes, so the quiet count is true.
    const sync = effect(() => {
      this.expanded();
      this.items();
      untracked(() => void this.syncHistory());
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
    void this.tauri.runNotificationAction(action, n.jobId);
  }

  markQuietRead(): void {
    this.markRead(this.quiet().map((record) => record.notificationId));
  }

  /** Unlocked, the overlay follows a drag; locked, it holds its place. */
  toggleLock(): void {
    this.unlocked.update((unlocked) => !unlocked);
    void this.tauri.hudUnlock(this.unlocked());
  }

  private pressedAt: { x: number; y: number } | null = null;

  /**
   * While unlocked, pressing and moving the overlay hands the pointer to the OS.
   * A press that stays put is still a click, so the pill opens and the lock
   * button stays reachable.
   */
  press(event: { button: number; clientX: number; clientY: number; target: EventTarget }): void {
    const onButton =
      event.target instanceof Element && event.target.closest('[data-slot="button"]');
    this.pressedAt =
      this.unlocked() && event.button === 0 && !onButton
        ? { x: event.clientX, y: event.clientY }
        : null;
  }

  drag(event: { clientX: number; clientY: number }): void {
    const start = this.pressedAt;
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
    this.pressedAt = null;
    void this.tauri.hudDrag();
  }

  release(): void {
    this.pressedAt = null;
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
 * What a waiting item asks, with who is asking: "Claude · Run `npm test`".
 * The asker is the title's lead ("Claude · add a health check…"); the ask
 * is the detail, which producers keep short.
 */
function Request({ n }: { n: NotificationPayload }) {
  if (!n.detail) return <>{n.title}</>;
  const asker = n.title.includes(' · ') ? n.title.split(' · ')[0] : null;
  return (
    <>
      {asker && <span className="asker">{asker} · </span>}
      <InlineText text={n.detail} />
    </>
  );
}

/**
 * The attention overlay. At rest, with nothing live, it is a small dot that
 * opens into the summary on hover. With work live it is a one-line pill: what
 * is running, how many quiet updates arrived, how many things wait on you.
 * Clicking it, or the
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
        width: Math.ceil(width),
        height: Math.ceil(height),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hud]);

  const items = hud.items();
  const quiet = hud.quiet();

  return (
    <div
      className="hud-surface"
      data-unlocked={hud.unlocked() || undefined}
      data-side={hud.side()}
      onMouseDown={(event) => hud.press(event)}
      onMouseMove={(event) => hud.drag(event)}
      onMouseUp={() => hud.release()}
    >
      <div className="frame" ref={frame}>
        {hud.expanded() ? (
          <section className="stack" aria-label="Activity">
            <div className="summary u-glass u-chrome">
              <span className="summary-text">{hud.summary()}</span>
              <Button size="sm" variant="ghost" onClick={() => hud.openRelay()}>
                Open Relay
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={hud.unlocked() ? 'Done moving' : 'Move the overlay'}
                title={hud.unlocked() ? 'Done moving' : 'Move the overlay'}
                aria-pressed={hud.unlocked()}
                onClick={() => hud.toggleLock()}
              >
                <Icon name={hud.unlocked() ? 'check' : 'move'} size={14} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Collapse"
                title="Collapse"
                onClick={() => hud.toggle()}
              >
                <Icon name="minus" size={14} />
              </Button>
            </div>
            {hud.unlocked() && (
              <p className="moving u-glass u-chrome">Drag the overlay where you want it.</p>
            )}

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
            {quiet.length > 0 && (
              <div className="quiet-row u-glass u-chrome">
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
                <Button size="sm" variant="ghost" onClick={() => hud.openRelay()}>
                  See in Today
                </Button>
              </div>
            )}
          </section>
        ) : (
          <button
            type="button"
            className={`pill u-glass u-chrome${items.length === 0 ? ' idle' : ''}`}
            aria-label={`Activity: ${hud.summary()}. Show details`}
            onClick={() => hud.toggle()}
          >
            {items.length === 0 && (
              <>
                <span className="dot" data-status="idle" />
                <span className="seg-title idle-label">{hud.summary()}</span>
              </>
            )}
            {hud.segments().map((n) => {
              const ring = n.status === 'running' && n.progress !== undefined;
              return (
                <span key={n.notificationId} className="seg" data-status={n.status}>
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
                  <span className="seg-title">{needsYou(n) ? <Request n={n} /> : n.title}</span>
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
          </button>
        )}
      </div>
    </div>
  );
}
