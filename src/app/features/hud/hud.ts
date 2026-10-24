import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { hueVar, type EntityHue } from '@core/entity-hue';
import type { NotificationAction } from '@core/events';
import { Icon } from '@shared/icon';
import { UmbraButtonComponent } from '@umbra/components/umbra-button/umbra-button.component';

export type HudStatus = 'running' | 'waiting' | 'blocked' | 'done' | 'idle';

/**
 * An ambient notification that floats over the desktop: one long-lived object,
 * its identity hue, how far it has got and what it is doing. It never asks for
 * a decision — anything that needs one goes to the palette.
 */
@Component({
  selector: 'rl-hud',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, UmbraButtonComponent],
  host: {
    class: 'u-glass u-chrome',
  },
  template: `
    <span class="u-entity-tile" [style.--entity-hue]="tone()">
      <rl-icon [name]="icon()" [size]="16" />
    </span>

    <div class="text">
      <p class="title">{{ title() }}</p>
      <p class="u-mono detail">{{ detail() }}</p>
    </div>

    <div class="state" [attr.data-status]="status()">
      <span class="dot"></span>
      <span>{{ statusLabel() }}</span>
      @if (queueLength() > 1) {
        <span class="queue-count" [attr.aria-label]="'Notification 1 of ' + queueLength()">
          1 / {{ queueLength() }}
        </span>
      }
    </div>

    <div class="controls">
      @for (item of actions(); track item.id) {
        <umbra-button size="sm" variant="ghost" (click)="action.emit(item)">
          {{ item.label }}
        </umbra-button>
      }
      <umbra-button
        size="icon"
        variant="ghost"
        [ariaLabel]="dismissLabel()"
        (click)="dismiss.emit()"
      >
        <rl-icon umbraButtonIcon name="x" [size]="14" />
      </umbra-button>
    </div>

    <span class="u-sr-only">{{ status() }}</span>

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
      position: relative;
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: var(--space-2) var(--space-5);
      align-items: center;
      inline-size: 100%;
      padding: var(--space-5) var(--space-6);
    }

    .text {
      min-inline-size: 0;
    }

    .controls {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      grid-column: 1 / -1;
      gap: var(--space-2);
    }

    :host ::ng-deep .controls umbra-button {
      width: auto;
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
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
    }

    /* Status is how it is going — never the entity hue. */
    .state {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      color: var(--text-muted);
      font-size: var(--text-11);
      white-space: nowrap;
    }

    .dot {
      inline-size: 6px;
      block-size: 6px;
      border-radius: var(--radius-pill);
      background: var(--status-idle);
    }

    .state[data-status='running'] .dot {
      background: var(--status-running);
    }
    .state[data-status='waiting'] .dot {
      background: var(--status-waiting);
    }
    .state[data-status='blocked'] .dot {
      background: var(--status-blocked);
    }
    .state[data-status='done'] .dot {
      background: var(--status-done);
    }

    .queue-count {
      margin-inline-start: var(--space-2);
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    .track {
      grid-column: 1 / -1;
    }
  `,
})
export class Hud {
  readonly title = input.required<string>();
  readonly detail = input<string>('');
  readonly icon = input<string>('circle');
  readonly hue = input.required<EntityHue>();
  readonly status = input<HudStatus>('idle');
  readonly queueLength = input(1);
  /** null hides the track entirely — never synthesise a percentage. */
  readonly progress = input<number | null>(null);
  readonly actions = input<readonly NotificationAction[]>([]);
  readonly dismissLabel = input('Dismiss');
  readonly dismiss = output<void>();
  readonly action = output<NotificationAction>();

  protected readonly tone = computed(() => hueVar(this.hue()));
  protected readonly statusLabel = computed(
    () =>
      ({
        running: 'Working',
        waiting: 'Waiting',
        blocked: 'Needs attention',
        done: 'Done',
        idle: 'Ready',
      })[this.status()],
  );
}
