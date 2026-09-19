import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { hueVar, type EntityHue } from '@core/entity-hue';
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
  template: `
    <span class="u-entity-tile" [style.--entity-hue]="tone()">
      <rl-icon [name]="icon()" [size]="16" />
    </span>

    <div class="text">
      <p class="title">{{ title() }}</p>
      <p class="u-mono detail">{{ detail() }}</p>
    </div>

    <span class="dot" [attr.data-status]="status()"></span>
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

  protected readonly tone = computed(() => hueVar(this.hue()));
}
