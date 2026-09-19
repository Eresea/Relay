import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { hueFor } from '@core/entity-hue';
import { NotificationCenter } from '@core/notification-center';

import { Hud } from './hud';

/**
 * The hud surface's root. Renders the single active notification, or nothing
 * — an empty overlay window that never draws is the correct idle state, not
 * a placeholder to fill in later.
 */
@Component({
  selector: 'rl-hud-surface',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Hud],
  template: `
    @if (notification(); as n) {
      <rl-hud
        [title]="n.title"
        [detail]="n.detail ?? ''"
        [icon]="n.icon ?? 'circle'"
        [hue]="hue(n.hueSource)"
        [status]="n.status"
        [progress]="n.progress ?? null"
      />
    }
  `,
  styles: `
    :host {
      display: block;
      inline-size: 100%;
    }
  `,
})
export class HudSurface {
  private readonly center = inject(NotificationCenter);

  protected readonly notification = this.center.current;
  protected readonly hue = hueFor;
}
