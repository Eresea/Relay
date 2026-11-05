import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type UmbraAlertTone = 'info' | 'success' | 'warning' | 'danger';

@Component({
  selector: 'umbra-alert',
  standalone: true,
  template: `
    <span class="icon" aria-hidden="true"><ng-content select="[umbraAlertIcon]" /></span>
    <div class="content">
      @if (title()) {
        <div class="title">{{ title() }}</div>
      }
      <div class="body"><ng-content /></div>
    </div>
    <div class="action"><ng-content select="[umbraAlertAction]" /></div>
  `,
  styleUrl: './umbra-alert.component.scss',
  host: {
    class: 'umbra-alert',
    '[attr.title]': 'null',
    '[attr.role]': "tone() === 'danger' || tone() === 'warning' ? 'alert' : 'status'",
    '[attr.data-tone]': 'tone()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UmbraAlertComponent {
  readonly tone = input<UmbraAlertTone>('info');
  readonly title = input('');
}
