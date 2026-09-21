import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { hueVar, type EntityHue } from '@core/entity-hue';
import type { NotificationAction } from '@core/events';
import { Icon } from '@shared/icon';

export type HudStatus = 'running' | 'waiting' | 'blocked' | 'done' | 'idle';

/**
 * An ambient notification that floats over the desktop: one long-lived object,
 * its identity hue, how far it has got and what it is doing. It never asks for
 * a decision — anything that needs one goes to the palette.
 */
@Component({
  selector: 'rl-hud',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
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

    <span class="dot" [attr.data-status]="status()"></span>

    <div class="controls">
      @for (item of actions(); track item.id) {
        <button type="button" class="action" (click)="action.emit(item)">
          {{ item.label }}
        </button>
      }
      <button
        type="button"
        class="dismiss"
        [attr.aria-label]="dismissLabel()"
        (click)="dismiss.emit()"
      >
        <rl-icon name="x" [size]="14" />
      </button>
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
      position: absolute;
      inset-block-start: var(--space-3);
      inset-inline-end: var(--space-4);
      display: flex;
      align-items: center;
      gap: var(--space-2);
      opacity: 0;
      pointer-events: none;
      transition: opacity var(--dur-hover) var(--ease-standard);
    }

    :host:hover .controls,
    :host:focus-within .controls {
      opacity: 1;
      pointer-events: auto;
    }

    .action,
    .dismiss {
      display: grid;
      place-items: center;
      min-block-size: var(--control-sm);
      padding-inline: var(--space-2);
      color: var(--text-subtle);
      border-radius: var(--radius-sm);
      white-space: nowrap;
      transition:
        background-color var(--dur-hover) var(--ease-standard),
        color var(--dur-hover) var(--ease-standard);
    }

    .action {
      font-size: var(--text-12);
    }

    .dismiss {
      inline-size: var(--control-sm);
      padding-inline: 0;
    }

    .action:hover,
    .dismiss:hover {
      color: var(--text-body);
      background: var(--tint-hover);
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
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Status is how it is going — never the entity hue. */
    .dot {
      inline-size: 6px;
      block-size: 6px;
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
  /** null hides the track entirely — never synthesise a percentage. */
  readonly progress = input<number | null>(null);
  readonly actions = input<readonly NotificationAction[]>([]);
  readonly dismissLabel = input('Dismiss');
  readonly dismiss = output<void>();
  readonly action = output<NotificationAction>();

  protected readonly tone = computed(() => hueVar(this.hue()));
}
