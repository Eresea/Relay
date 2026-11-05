import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { UmbraEntityHue } from '../umbra-entity-tile/umbra-entity-hue';

export type UmbraMetricTone = 'neutral' | 'running' | 'waiting' | 'blocked' | 'positive' | 'negative' | 'accent';

/** Compact stat cell for a metric strip; figures use tabular numerals. */
@Component({
  selector: 'umbra-metric-tile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dl class="metric">
      <dt class="label">{{ label() }}</dt>
      <dd class="figure">
        <span class="icon" aria-hidden="true"><ng-content select="[umbraMetricTileIcon]" /></span>
        @if (hue()) {
          <span class="hue" aria-hidden="true"></span>
        }
        <span class="value">{{ value() }}</span>
        @if (delta()) {
          <span class="delta">{{ delta() }}</span>
        }
      </dd>
    </dl>
  `,
  styleUrl: './umbra-metric-tile.component.scss',
  host: {
    class: 'umbra-metric-tile',
    '[attr.data-tone]': 'tone()',
    '[attr.data-hue]': 'hue() || null',
  },
})
export class UmbraMetricTileComponent {
  readonly value = input.required<string>();
  readonly label = input.required<string>();
  readonly tone = input<UmbraMetricTone>('neutral');
  /** Identity hue, when the metric belongs to a specific object. Drawn as a dot: hue never colours text. */
  readonly hue = input<UmbraEntityHue | ''>('');
  /** Signed change, e.g. "+4.2%". Reported in text, not by colour alone. */
  readonly delta = input<string>('');
}
