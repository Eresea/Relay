import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type UmbraSeparatorOrientation = 'horizontal' | 'vertical';

@Component({
  selector: 'umbra-separator',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
  styleUrl: './umbra-separator.component.scss',
  host: {
    class: 'umbra-separator',
    '[attr.data-orientation]': 'orientation()',
    '[attr.role]': "decorative() ? null : 'separator'",
    '[attr.aria-orientation]': 'decorative() ? null : orientation()',
    '[attr.aria-hidden]': "decorative() ? 'true' : null",
  },
})
export class UmbraSeparatorComponent {
  readonly orientation = input<UmbraSeparatorOrientation>('horizontal');
  readonly decorative = input(true);
}
