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
        <h3>{{ title() }}</h3>
        @if (description()) {
          <p>{{ description() }}</p>
        }
        <div class="actions"><ng-content select="[umbraEmptyStateAction]" /></div>
      </div>
    </section>
  `,
  styleUrl: './umbra-empty-state.component.scss',
  host: { class: 'umbra-empty-state' },
})
export class UmbraEmptyStateComponent {
  readonly title = input.required<string>();
  readonly description = input<string | null>(null);
}
