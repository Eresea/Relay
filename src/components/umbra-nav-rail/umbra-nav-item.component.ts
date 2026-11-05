import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { UmbraNavOrientation } from '../umbra-nav-rail/umbra-nav-rail.component';

@Component({
  selector: 'umbra-nav-item',
  standalone: true,
  template: `
    <button
      class="umbra-nav-item"
      type="button"
      [attr.data-active]="active() ? '' : null"
      [attr.data-orientation]="orientation()"
      [attr.aria-current]="active() ? 'page' : null"
      [attr.aria-label]="ariaLabel() || null"
      [attr.aria-expanded]="ariaExpanded()"
      [attr.aria-haspopup]="ariaHasPopup()"
      [attr.title]="label()"
      [disabled]="disabled()"
      (click)="activated.emit()"
    >
      <span class="icon" aria-hidden="true"><ng-content select="[umbraNavIcon]" /></span>
      <span class="label">{{ label() }}</span>
    </button>
  `,
  styleUrl: './umbra-nav-item.component.scss',
  host: { class: 'umbra-nav-item-host' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UmbraNavItemComponent {
  readonly label = input.required<string>();
  readonly ariaLabel = input<string>();
  readonly ariaExpanded = input<boolean>();
  readonly ariaHasPopup = input<'dialog' | 'menu'>();
  readonly active = input(false);
  readonly disabled = input(false);
  readonly orientation = input<UmbraNavOrientation>('vertical');
  readonly activated = output<void>();
}
