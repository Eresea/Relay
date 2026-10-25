import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { hueVar, type EntityHue } from '@core/entity-hue';
import type { NotificationAction } from '@core/events';
import { Icon } from '@shared/icon';
import { UmbraButtonComponent } from '@umbra/components/umbra-button/umbra-button.component';

export type HudStatus = 'running' | 'waiting' | 'blocked' | 'done' | 'idle';

const STATUS_LABEL: Record<HudStatus, string> = {
  running: 'Running',
  waiting: 'Needs you',
  blocked: 'Needs attention',
  done: 'Done',
  idle: 'Ready',
};

/**
 * One card in the attention stack: a long-lived object, its identity hue, how
 * far it has got and what it is doing. A card that waits on you says so and
 * puts its first action forward; every other card only reports.
 */
@Component({
  selector: 'rl-hud',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, UmbraButtonComponent],
  host: {
    class: 'u-glass u-chrome',
    '[attr.data-status]': 'status()',
  },
  template: `
    <span class="u-entity-tile tile" [style.--entity-hue]="tone()">
      <rl-icon [name]="icon()" [size]="16" />
    </span>

    <div class="text">
      <p class="title">{{ title() }}</p>
      @if (detail()) {
        <p class="detail">{{ detail() }}</p>
      }
    </div>

    <div class="state">
      <span class="dot"></span>
      <span>{{ statusLabel() }}</span>
      <umbra-button
        size="icon"
        variant="ghost"
        [ariaLabel]="dismissLabel()"
        (click)="dismiss.emit()"
      >
        <rl-icon umbraButtonIcon name="x" [size]="14" />
      </umbra-button>
    </div>

    @if (actions().length > 0) {
      <div class="controls">
        @for (item of actions(); track item.id; let first = $first) {
          <umbra-button
            size="sm"
            [variant]="first && needsYou() ? 'default' : 'secondary'"
            (click)="action.emit(item)"
          >
            {{ item.label }}
          </umbra-button>
        }
      </div>
    }

    @if (progress() !== null) {
      <div
        class="u-entity-track track"
        [style.--entity-hue]="tone()"
        role="progressbar"
        [attr.aria-valuenow]="progress()"
        aria-valuemin="0"
        aria-valuemax="100"
        [attr.aria-label]="title() + ' progress'"
      >
        <div class="u-entity-track-fill" [style.inline-size.%]="progress()"></div>
      </div>
    }
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: var(--space-2) var(--space-5);
      align-items: center;
      padding: var(--space-5) var(--space-6);
      border-radius: var(--radius-xl);
      box-shadow: var(--hud-shadow), var(--glass-rim);
    }

    /* Status colours the edge of a card that waits on you — never its hue. */
    :host([data-status='waiting']),
    :host([data-status='blocked']) {
      box-shadow:
        var(--hud-shadow),
        var(--glass-rim),
        0 0 0 1px color-mix(in srgb, var(--hud-edge) 40%, transparent);
    }
    :host([data-status='waiting']) {
      --hud-edge: var(--status-waiting);
    }
    :host([data-status='blocked']) {
      --hud-edge: var(--status-blocked);
    }

    .title {
      margin: 0;
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
      color: var(--text-strong);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .detail {
      margin: var(--space-1) 0 0;
      font-size: var(--text-12);
      color: var(--text-muted);
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
    }

    .state {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      align-self: start;
      color: var(--text-subtle);
      font-size: var(--text-11);
      white-space: nowrap;
    }

    .state umbra-button {
      margin-inline-end: calc(var(--space-3) * -1);
    }

    .dot {
      inline-size: 7px;
      block-size: 7px;
      border-radius: var(--radius-pill);
      background: var(--status-idle);
    }
    :host([data-status='running']) .dot {
      background: var(--status-running);
    }
    :host([data-status='waiting']) .dot {
      background: var(--status-waiting);
    }
    :host([data-status='blocked']) .dot {
      background: var(--status-blocked);
    }
    :host([data-status='done']) .dot {
      background: var(--status-done);
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
      grid-column: 2 / -1;
      margin-block-start: var(--space-3);
    }

    :host ::ng-deep .controls umbra-button {
      width: auto;
    }

    .track {
      grid-column: 1 / -1;
      margin-block-start: var(--space-3);
    }
  `,
})
export class Hud {
  readonly title = input.required<string>();
  readonly detail = input<string>('');
  readonly icon = input<string>('circle');
  readonly hue = input.required<EntityHue>();
  readonly status = input<HudStatus>('idle');
  /** null hides the track entirely — never synthesise a percentage. */
  readonly progress = input<number | null>(null);
  readonly actions = input<readonly NotificationAction[]>([]);
  readonly dismissLabel = input('Dismiss');
  readonly dismiss = output<void>();
  readonly action = output<NotificationAction>();

  protected readonly tone = computed(() => hueVar(this.hue()));
  protected readonly statusLabel = computed(() => STATUS_LABEL[this.status()]);
  protected readonly needsYou = computed(
    () => this.status() === 'waiting' || this.status() === 'blocked',
  );
}
