import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The single container primitive: default border, large radius, card surface.
 *
 * Cards do not nest inside cards — when content needs a second level, use a
 * separator and open rows. There are no coloured left borders and no accent
 * headers: hierarchy comes from border and surface value, never from a stripe.
 */
@Component({
  selector: 'umbra-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (title() || description()) {
      <header class="header">
        <div class="copy">
          @if (title()) {
            @switch (headingLevel()) {
              @case (2) {
                <h2 class="title">{{ title() }}</h2>
              }
              @case (4) {
                <h4 class="title">{{ title() }}</h4>
              }
              @default {
                <h3 class="title">{{ title() }}</h3>
              }
            }
          }
          @if (description()) {
            <p class="description">{{ description() }}</p>
          }
        </div>
        <div class="actions"><ng-content select="[cardActions]" /></div>
      </header>
    }
    <div class="body"><ng-content /></div>
    <footer class="footer"><ng-content select="[cardFooter]" /></footer>
  `,
  styleUrl: './umbra-card.component.scss',
  host: {
    class: 'umbra-card',
    '[attr.title]': 'null',
    '[attr.data-interactive]': 'interactive() ? "" : null',
  },
})
export class UmbraCardComponent {
  readonly title = input<string>('');
  readonly description = input<string>('');
  readonly headingLevel = input<2 | 3 | 4>(3);
  /** Lifts the border on hover. Only for a card that is itself a target. */
  readonly interactive = input<boolean>(false);
}
