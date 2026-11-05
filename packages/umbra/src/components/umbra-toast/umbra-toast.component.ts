import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export type UmbraToastTone = 'info' | 'success' | 'warning' | 'danger';

@Component({
  selector: 'umbra-toast',
  standalone: true,
  template: `
    <div
      class="toast"
      [attr.role]="tone() === 'danger' ? 'alert' : 'status'"
      [attr.aria-live]="tone() === 'danger' ? 'assertive' : 'polite'"
    >
      @if (tone() !== 'info') {
        <span class="dot" aria-hidden="true"></span>
      }
      <div class="content">
        @if (title()) {
          <div class="title">{{ title() }}</div>
        }
        @if (message()) {
          <p class="message">{{ message() }}</p>
        }
      </div>
      @if (dismissible()) {
        <button type="button" class="dismiss" [attr.aria-label]="dismissLabel()" (click)="dismiss.emit()">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      }
    </div>
  `,
  styleUrl: './umbra-toast.component.scss',
  host: {
    class: 'umbra-toast',
    '[attr.title]': 'null',
    '[attr.data-tone]': 'tone()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UmbraToastComponent {
  readonly tone = input<UmbraToastTone>('info');
  readonly title = input('');
  readonly message = input('');
  readonly dismissible = input(true);
  readonly dismissLabel = input('Dismiss notification');
  readonly dismiss = output<void>();
}
