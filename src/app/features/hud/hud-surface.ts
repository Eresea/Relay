import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { hueFor, hueVar } from '@core/entity-hue';
import type { NotificationAction, NotificationPayload } from '@core/events';
import { NotificationCenter } from '@core/notification-center';
import { TauriBridge, type HudMode } from '@core/tauri';
import { Icon } from '@shared/icon';
import { UmbraButtonComponent } from '@umbra/components/umbra-button/umbra-button.component';

import { Hud } from './hud';

const MAX_CARDS = 5;
const MAX_SEGMENTS = 2;
const STACK_ORDER = { running: 0, waiting: 1, blocked: 1, done: 2 } as const;

const needsYou = (n: NotificationPayload) => n.status === 'waiting' || n.status === 'blocked';
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The attention overlay. At rest it is a one-line pill: what is running, how
 * many quiet updates arrived, how many things wait on you. Clicking it, or the
 * attention shortcut, opens the stack: one card per live item, the ones that
 * need you carrying their actions.
 *
 * The surface measures itself and asks the core for a window that fits, so the
 * transparent window never covers more of the desktop than the glass does.
 * With nothing live and the stack closed, the window goes away entirely.
 */
@Component({
  selector: 'rl-hud-surface',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Hud, Icon, UmbraButtonComponent],
  template: `
    <div class="frame" #frame>
      @if (expanded()) {
        <section class="stack" aria-label="Activity">
          <div class="summary u-glass u-chrome">
            @if (quiet().length > 0) {
              <span class="faces">
                @for (record of quietFaces(); track record.notificationId) {
                  <span class="u-entity-tile face" [style.--entity-hue]="tone(record.hueSource)">
                    <rl-icon [name]="record.icon ?? 'inbox'" [size]="14" />
                  </span>
                }
              </span>
              <span class="summary-text">{{ quietLabel() }}</span>
              <umbra-button size="sm" variant="ghost" (click)="markQuietRead()">
                Mark read
              </umbra-button>
            } @else {
              <span class="summary-text">{{ summary() }}</span>
            }
            <umbra-button size="sm" variant="ghost" (click)="openRelay()">Open Relay</umbra-button>
            <umbra-button size="icon" variant="ghost" ariaLabel="Collapse" (click)="toggle()">
              <rl-icon umbraButtonIcon name="minus" [size]="14" />
            </umbra-button>
          </div>

          @for (n of cards(); track n.notificationId) {
            <rl-hud
              [title]="n.title"
              [detail]="n.detail ?? ''"
              [icon]="n.icon ?? 'circle'"
              [hue]="hue(n.hueSource)"
              [status]="n.status"
              [progress]="n.progress ?? null"
              [actions]="n.actions ?? []"
              (dismiss)="dismiss(n.notificationId)"
              (action)="runAction($event, n)"
            />
          }
          @if (overflow() > 0) {
            <p class="more">{{ overflow() }} more in Relay</p>
          }
        </section>
      } @else if (items().length > 0) {
        <button
          type="button"
          class="pill u-glass u-chrome"
          [attr.aria-label]="pillLabel()"
          (click)="toggle()"
        >
          @for (n of segments(); track n.notificationId) {
            <span class="seg">
              @if (n.status === 'running' && n.progress !== undefined) {
                <span
                  class="ring"
                  [style.--entity-hue]="tone(n.hueSource)"
                  [style.--progress]="n.progress"
                ></span>
              } @else {
                <span class="dot" [attr.data-status]="n.status"></span>
              }
              <span class="seg-title">{{ n.title }}</span>
              @if (n.status === 'running' && n.progress !== undefined) {
                <span class="num">{{ n.progress }}%</span>
              }
            </span>
          }
          @if (hiddenCount() > 0) {
            <span class="seg num">+{{ hiddenCount() }}</span>
          }
          @if (quiet().length > 0) {
            <span class="seg quiet">
              <rl-icon name="inbox" [size]="14" />
              <span class="num">{{ quiet().length }}</span>
            </span>
          }
          @if (waiting().length > 0) {
            <span class="badge">{{ waiting().length }}</span>
          }
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      --hud-shadow: 0 8px 24px -8px rgb(0 0 0 / 0.55);
      display: block;
    }

    /* Sized by content, never by the window: the window is sized from this. */
    .frame {
      position: fixed;
      inset-block-start: 0;
      inset-inline-start: 0;
      inline-size: max-content;
      /* Room for the shadow, which the window would otherwise clip. */
      padding: var(--space-6) var(--space-6) var(--space-7);
    }

    .pill {
      display: flex;
      align-items: center;
      gap: var(--space-5);
      block-size: 34px;
      padding-inline: var(--space-5);
      border-radius: var(--radius-pill);
      box-shadow: var(--hud-shadow), var(--glass-rim);
      font-size: var(--text-12);
      color: var(--text-body);
      transition: border-color var(--dur-fast) var(--ease-standard);
    }

    .pill:hover {
      border-color: color-mix(in srgb, var(--text-body) 22%, transparent);
    }

    .pill:has(.badge) {
      padding-inline-end: var(--space-3);
    }

    .seg {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      white-space: nowrap;
    }

    .seg + .seg {
      padding-inline-start: var(--space-5);
      border-inline-start: 1px solid var(--glass-edge);
    }

    .seg-title {
      max-inline-size: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .num {
      font-family: var(--font-mono);
      font-size: var(--text-11);
      font-variant-numeric: tabular-nums;
      color: var(--text-subtle);
    }

    .quiet {
      color: var(--text-subtle);
    }

    .ring {
      inline-size: 14px;
      block-size: 14px;
      border-radius: var(--radius-pill);
      background: conic-gradient(
        var(--entity-hue) calc(var(--progress) * 1%),
        color-mix(in srgb, var(--text-body) 14%, transparent) 0
      );
      mask: radial-gradient(circle, transparent 4px, #000 4.5px);
    }

    .dot {
      inline-size: 7px;
      block-size: 7px;
      border-radius: var(--radius-pill);
      background: var(--status-idle);
    }
    .dot[data-status='running'] {
      background: var(--status-running);
    }
    .dot[data-status='waiting'] {
      background: var(--status-waiting);
    }
    .dot[data-status='blocked'] {
      background: var(--status-blocked);
    }
    .dot[data-status='done'] {
      background: var(--status-done);
    }

    .badge {
      display: grid;
      place-items: center;
      min-inline-size: 22px;
      block-size: 22px;
      padding-inline: var(--space-3);
      border-radius: var(--radius-pill);
      background: var(--status-waiting);
      color: var(--zinc-950);
      font-size: var(--text-11);
      font-weight: var(--weight-semibold);
      font-variant-numeric: tabular-nums;
    }

    .stack {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      inline-size: 400px;
    }

    .summary {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-3) var(--space-3) var(--space-3) var(--space-5);
      border-radius: var(--radius-xl);
      box-shadow: var(--hud-shadow), var(--glass-rim);
      font-size: var(--text-12);
      color: var(--text-muted);
    }

    .summary-text {
      flex: 1;
      min-inline-size: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .faces {
      display: flex;
      gap: var(--space-2);
      margin-inline-end: var(--space-3);
    }

    .face {
      inline-size: 20px;
      block-size: 20px;
      border-radius: var(--radius-sm);
    }

    :host ::ng-deep .summary umbra-button {
      width: auto;
    }

    .more {
      margin: 0;
      padding-inline: var(--space-5);
      font-size: var(--text-11);
      color: var(--text-subtle);
    }
  `,
})
export class HudSurface {
  private readonly center = inject(NotificationCenter);
  private readonly tauri = inject(TauriBridge);
  private readonly frame = viewChild.required<ElementRef<HTMLElement>>('frame');
  private readonly measured = signal<{ mode: HudMode; width: number; height: number } | null>(null);

  protected readonly items = this.center.items;
  protected readonly expanded = this.center.expanded;
  protected readonly quiet = this.center.quiet;
  protected readonly hue = hueFor;

  protected readonly waiting = computed(() => this.items().filter(needsYou));
  private readonly calm = computed(() => this.items().filter((n) => !needsYou(n)));

  /** What is running comes first; with nothing else live, show what waits on you. */
  protected readonly segments = computed(() =>
    (this.calm().length > 0 ? this.calm() : this.waiting()).slice(0, MAX_SEGMENTS),
  );
  /** Live items the pill has no room for. Waiting items are counted by the badge instead. */
  protected readonly hiddenCount = computed(() =>
    this.calm().length > 0 ? this.calm().length - this.segments().length : 0,
  );

  private readonly ordered = computed(() =>
    [...this.items()].sort((a, b) => STACK_ORDER[a.status] - STACK_ORDER[b.status]),
  );
  protected readonly cards = computed(() => this.ordered().slice(0, MAX_CARDS));
  protected readonly overflow = computed(() => this.items().length - this.cards().length);

  protected readonly quietFaces = computed(() => this.quiet().slice(0, 3));
  protected readonly quietLabel = computed(() => plural(this.quiet().length, 'quiet update'));
  protected readonly summary = computed(() => {
    const counts = [
      [this.items().filter((n) => n.status === 'running').length, 'running'],
      [this.waiting().length, 'need you'],
      [this.items().filter((n) => n.status === 'done').length, 'done'],
    ] as const;
    const parts = counts.filter(([count]) => count > 0).map(([count, word]) => `${count} ${word}`);
    return parts.length > 0 ? parts.join(' · ') : 'Nothing running';
  });
  protected readonly pillLabel = computed(() => `Activity: ${this.summary()}. Show details`);

  private readonly visible = computed(() => this.expanded() || this.items().length > 0);

  constructor() {
    const destroyRef = inject(DestroyRef);

    afterNextRender(() => {
      const element = this.frame().nativeElement;
      const observer = new ResizeObserver(() => {
        const { width, height } = element.getBoundingClientRect();
        this.measured.set({
          mode: this.expanded() ? 'stack' : 'pill',
          width: Math.ceil(width),
          height: Math.ceil(height),
        });
      });
      observer.observe(element);
      destroyRef.onDestroy(() => observer.disconnect());
    });

    // The core shows the window when a notification arrives, because it is
    // the only side that knows one is about to exist. Everything after that
    // — its size, its anchor, taking it off screen — follows what is drawn.
    effect(() => {
      if (!this.visible()) {
        void this.tauri.runCoreCommand({ id: 'hide_hud' });
        return;
      }
      const layout = this.measured();
      if (layout) void this.tauri.hudLayout(layout.mode, layout.width, layout.height);
    });

    // Read state changes in whichever window you read in. Re-read the stored
    // copy each time the overlay comes back, so the quiet count is true.
    effect(() => {
      if (this.visible()) untracked(() => void this.syncHistory());
    });
  }

  protected tone(hueSource: string): string {
    return hueVar(hueFor(hueSource));
  }

  protected toggle(): void {
    this.center.toggleExpanded();
  }

  /** Dismissing or acting on a card is reading it: it must not come back as quiet. */
  protected dismiss(notificationId: string): void {
    this.center.dismiss(notificationId);
    this.markRead([notificationId]);
  }

  protected runAction(action: NotificationAction, n: NotificationPayload): void {
    this.dismiss(n.notificationId);
    if (action.id === 'open') void this.tauri.openUrl(action.url);
    if (action.id === 'cancel') void this.tauri.cancelJob(n.jobId);
  }

  protected markQuietRead(): void {
    this.markRead(this.quiet().map((record) => record.notificationId));
  }

  private markRead(ids: readonly string[]): void {
    for (const id of ids) this.center.markRead(id);
    void this.tauri.notificationsMarkRead(ids);
  }

  protected openRelay(): void {
    this.center.toggleExpanded();
    void this.tauri.runCoreCommand({ id: 'open_main' });
  }

  private async syncHistory(): Promise<void> {
    if (!this.tauri.available) return;
    this.center.syncHistory(await this.tauri.notificationsList());
  }
}
