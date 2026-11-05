import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type UmbraNavOrientation = 'vertical' | 'horizontal';

@Component({
  selector: 'umbra-nav-rail',
  standalone: true,
  template: `
    <nav
      class="umbra-nav-rail"
      [attr.aria-label]="ariaLabel()"
      [attr.data-orientation]="orientation()"
      [attr.data-mobile-orientation]="mobileOrientation()"
    >
      <ng-content />
    </nav>
  `,
  styleUrl: './umbra-nav-rail.component.scss',
  host: { class: 'umbra-nav-rail-host' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UmbraNavRailComponent {
  readonly orientation = input<UmbraNavOrientation>('vertical');
  readonly mobileOrientation = input<UmbraNavOrientation>('horizontal');
  readonly ariaLabel = input('Primary navigation');
}
