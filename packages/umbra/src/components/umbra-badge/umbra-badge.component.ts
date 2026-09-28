import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type UmbraBadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';

@Component({
  selector: 'umbra-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<ng-content />',
  styleUrl: './umbra-badge.component.scss',
  host: {
    class: 'umbra-badge',
    '[attr.data-variant]': 'variant()',
  },
})
export class UmbraBadgeComponent {
  readonly variant = input<UmbraBadgeVariant>('default');
}
