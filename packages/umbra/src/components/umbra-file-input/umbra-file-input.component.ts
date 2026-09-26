import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

@Component({
  selector: 'umbra-file-input',
  standalone: true,
  templateUrl: './umbra-file-input.component.html',
  styleUrl: './umbra-file-input.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'umbra-file-input-host' },
})
export class UmbraFileInputComponent {
  readonly accept = input('');
  readonly multiple = input(false);
  readonly fileSelected = output<Event>();
}
