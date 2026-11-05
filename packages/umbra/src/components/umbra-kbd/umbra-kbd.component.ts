import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Renders a keyboard shortcut as separate semantic keycaps. */
@Component({
  selector: 'umbra-kbd',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (key of parsed(); track key) {
      <kbd>{{ key }}</kbd>
    }
  `,
  styleUrl: './umbra-kbd.component.scss',
  host: { class: 'umbra-kbd' },
})
export class UmbraKbdComponent {
  /** A combo string ("⌘+K") or its already split keys. */
  readonly keys = input<string | readonly string[]>('');
  readonly parsed = computed(() => {
    const value = this.keys();
    const list = typeof value === 'string' ? value.split('+') : value;
    return list.map((key) => key.trim()).filter((key) => key.length > 0);
  });
}
