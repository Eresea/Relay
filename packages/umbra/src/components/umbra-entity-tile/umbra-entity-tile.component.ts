import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { hueFor, type UmbraEntityHue } from './umbra-entity-hue';

/** Tinted icon tile; consumers project the icon for their platform. */
@Component({
  selector: 'umbra-entity-tile',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="tile"><ng-content select="[umbraEntityTileIcon]" /></span>
  `,
  styleUrl: './umbra-entity-tile.component.scss',
  host: {
    class: 'umbra-entity-tile',
    '[attr.data-hue]': 'resolvedHue()',
    '[attr.data-size]': 'size()',
    '[attr.role]': 'label() ? "img" : "presentation"',
    '[attr.aria-label]': 'label() || null',
  },
})
export class UmbraEntityTileComponent {
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  /** Stable identity for the object. Drives the hue when `hue` is not set. */
  readonly entityId = input<string>('');
  /** Force a hue. Prefer `entityId` so the colour stays stable across surfaces. */
  readonly hue = input<UmbraEntityHue | ''>('');
  /** Set only when the tile is the sole carrier of meaning. */
  readonly label = input<string>('');
  readonly resolvedHue = computed(() => this.hue() || hueFor(this.entityId() || this.label()));
}
