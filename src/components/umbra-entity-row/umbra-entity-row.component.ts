import { NgTemplateOutlet } from '@angular/common';
import { booleanAttribute, ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { UmbraEntityTileComponent } from '../umbra-entity-tile/umbra-entity-tile.component';
import { hueFor, type UmbraEntityHue } from '../umbra-entity-tile/umbra-entity-hue';
import { UmbraStatusDotComponent, type UmbraStatus } from '../umbra-status-dot/umbra-status-dot.component';

/** One object in a list: tinted tile, name, lifecycle state, progress, trailing meta. */
@Component({
  selector: 'umbra-entity-row',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, UmbraEntityTileComponent, UmbraStatusDotComponent],
  template: `
    <ng-template #content>
      <div class="row">
        <umbra-entity-tile size="sm" [entityId]="entityId() || name()" [hue]="hue()">
          <span umbraEntityTileIcon><ng-content select="[umbraEntityRowIcon]" /></span>
        </umbra-entity-tile>
        <span class="copy">
          <span class="heading">
            <span class="name">{{ name() }}</span>
            @if (state()) {
              <umbra-status-dot [state]="state()!" [label]="!detail()" />
            }
          </span>
          @if (detail()) {
            <span class="detail">{{ detail() }}</span>
          }
          @if (progress() !== null) {
            <span class="track" role="img" [attr.aria-label]="name() + ': ' + rounded() + '% complete'">
              <span class="fill" [style.width.%]="clamped()"></span>
            </span>
          }
        </span>
        @if (progress() !== null) {
          <span class="meta">{{ rounded() }}%</span>
        } @else if (meta()) {
          <span class="meta">{{ meta() }}</span>
        }
      </div>
    </ng-template>

    @if (interactive()) {
      <button type="button" class="activator" [attr.aria-pressed]="selected()" (click)="activate.emit()">
        <ng-container [ngTemplateOutlet]="content" />
      </button>
    } @else {
      <ng-container [ngTemplateOutlet]="content" />
    }
  `,
  styleUrl: './umbra-entity-row.component.scss',
  host: {
    class: 'umbra-entity-row',
    '[attr.data-selected]': 'selected() ? "" : null',
    '[attr.data-hue]': 'resolvedHue()',
  },
})
export class UmbraEntityRowComponent {
  readonly name = input.required<string>();
  readonly detail = input<string>('');
  readonly entityId = input<string>('');
  readonly hue = input<UmbraEntityHue | ''>('');
  readonly state = input<UmbraStatus | null>(null);
  /** 0–100, or null when the object has no progress to report. */
  readonly progress = input<number | null>(null);
  readonly meta = input<string>('');
  readonly selected = input(false, { transform: booleanAttribute });
  readonly interactive = input(false, { transform: booleanAttribute });
  readonly activate = output<void>();

  readonly resolvedHue = computed(() => this.hue() || hueFor(this.entityId() || this.name()));
  readonly clamped = computed(() => Math.max(0, Math.min(100, this.progress() ?? 0)));
  readonly rounded = computed(() => Math.round(this.clamped()));
}
