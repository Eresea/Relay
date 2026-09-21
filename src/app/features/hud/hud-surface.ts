import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';

import { hueFor } from '@core/entity-hue';
import type { NotificationAction } from '@core/events';
import { NotificationCenter } from '@core/notification-center';
import { TauriBridge } from '@core/tauri';

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
        [actions]="n.actions ?? []"
        [dismissLabel]="n.status === 'running' || n.status === 'waiting' ? 'Cancel' : 'Dismiss'"
        (dismiss)="dismiss(n.notificationId, n.jobId, n.status)"
        (action)="runAction($event, n.notificationId, n.jobId)"
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
  private readonly tauri = inject(TauriBridge);

  protected readonly notification = this.center.current;
  protected readonly hue = hueFor;

  protected dismiss(notificationId: string, jobId: string, status: string): void {
    this.center.dismiss(notificationId);
    if (status === 'running' || status === 'waiting') void this.tauri.cancelJob(jobId);
  }

  protected runAction(action: NotificationAction, notificationId: string, jobId: string): void {
    this.center.dismiss(notificationId);
    if (action.id === 'open') void this.tauri.openUrl(action.url);
    if (action.id === 'cancel') void this.tauri.cancelJob(jobId);
  }

  constructor() {
    // The core shows the HUD when a notification arrives; taking it back off
    // screen is this surface's call, because the grace period that keeps a
    // finished notification readable for a moment after its job ends lives
    // here. An overlay left up with nothing in it is just a hole in the
    // desktop.
    effect(() => {
      if (this.notification() === null) {
        void this.tauri.runCoreCommand({ id: 'hide_hud' });
      }
    });
  }
}
