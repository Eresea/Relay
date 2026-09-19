import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A keycap. The only non-Lucide glyphs in the system are the platform keyboard
 * symbols, set in mono inside this component.
 */
@Component({
  selector: 'rl-kbd',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (key of keys(); track key) {
      <kbd>{{ key }}</kbd>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      gap: var(--space-2);
      align-items: center;
    }

    kbd {
      display: grid;
      place-items: center;
      min-inline-size: 18px;
      block-size: 18px;
      padding: 0 var(--space-3);
      font-family: var(--font-mono);
      font-size: var(--text-11);
      line-height: 1;
      color: var(--text-subtle);
      background: var(--bg-raised);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-xs);
      box-shadow: var(--keycap-hairline);
    }
  `,
})
export class Kbd {
  readonly keys = input.required<readonly string[]>();
}
