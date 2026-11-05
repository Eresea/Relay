import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'umbra-empty-state',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="empty-state" role="status">
      <span class="icon-slot" aria-hidden="true">
        <ng-content select="[umbraEmptyStateIcon]" />
      </span>
      <div class="content">
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
        @if (description()) {
          <p>{{ description() }}</p>
        }
        <div class="actions"><ng-content select="[umbraEmptyStateAction]" /></div>
      </div>
    </section>
  `,
  styleUrl: './umbra-empty-state.component.scss',
  host: { class: 'umbra-empty-state', '[attr.title]': 'null' },
})
export class UmbraEmptyStateComponent {
  readonly title = input.required<string>();
  readonly description = input<string | null>(null);
  readonly headingLevel = input<2 | 3 | 4>(3);
}
