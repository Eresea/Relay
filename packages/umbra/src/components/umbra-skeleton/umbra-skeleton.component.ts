import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type UmbraSkeletonShape = 'rectangle' | 'circle';
export type UmbraSkeletonAnimation = 'shimmer' | 'pulse' | 'none';
export type UmbraSkeletonRadius = 'sm' | 'md' | 'lg';

@Component({
  selector: 'umbra-skeleton',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  styleUrl: './umbra-skeleton.component.scss',
  host: {
    class: 'umbra-skeleton',
    'aria-hidden': 'true',
    '[attr.data-shape]': 'shape()',
    '[attr.data-animation]': 'animation()',
    '[attr.data-radius]': 'radius()',
    '[style.width]': 'width()',
    '[style.height]': 'height()',
  },
})
export class UmbraSkeletonComponent {
  readonly width = input('100%');
  readonly height = input('var(--space-8)');
  readonly shape = input<UmbraSkeletonShape>('rectangle');
  readonly animation = input<UmbraSkeletonAnimation>('shimmer');
  readonly radius = input<UmbraSkeletonRadius>('sm');
}
