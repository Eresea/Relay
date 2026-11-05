import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

export interface UmbraTab {
  readonly value: string;
  readonly label: string;
  /** Text for an icon font; see `iconClass`. */
  readonly icon?: string;
  readonly count?: number;
  readonly disabled?: boolean;
}

@Component({
  selector: 'umbra-tabs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (variant() === 'group') {
      <span class="selection" aria-hidden="true"></span>
    }
    @for (tab of tabs(); track tab.value; let index = $index) {
      <button
        type="button"
        role="tab"
        [attr.aria-selected]="tab.value === value()"
        [disabled]="tab.disabled"
        [tabIndex]="tab.value === value() ? 0 : -1"
        (click)="tabChange.emit(tab.value)"
        (keydown)="onKeydown($event, index)"
      >
        @if (tab.icon) {
          <span class="icon" [class]="iconClass()" aria-hidden="true">{{ tab.icon }}</span>
        }
        <span>{{ tab.label }}</span>
        @if (tab.count !== undefined) {
          <span class="count">{{ tab.count }}</span>
        }
      </button>
    }
  `,
  styleUrl: './umbra-tabs.component.scss',
  host: {
    class: 'umbra-tabs',
    role: 'tablist',
    '[attr.data-variant]': 'variant()',
    '[style.--tab-count]': 'tabs().length',
    '[style.--selected-index]': 'selectedIndex()',
    '[attr.aria-label]': 'ariaLabel() || null',
  },
})
export class UmbraTabsComponent {
  readonly tabs = input.required<readonly UmbraTab[]>();
  readonly value = input.required<string>();
  readonly variant = input<'underline' | 'segmented' | 'group'>('underline');
  readonly ariaLabel = input.required<string>();
  /** The consumer's icon font class, applied to each tab's `icon` text. */
  readonly iconClass = input('');
  readonly tabChange = output<string>();

  protected readonly selectedIndex = computed(() =>
    Math.max(0, this.tabs().findIndex((tab) => tab.value === this.value())),
  );

  protected onKeydown(event: KeyboardEvent, index: number): void {
    const tabs = this.tabs();
    if (!tabs.length) return;
    let next = index;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length;
    else return;

    event.preventDefault();
    const step = event.key === 'Home' || event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    for (let offset = 0; offset < tabs.length && tabs[next].disabled; offset++) {
      next = (next + step + tabs.length) % tabs.length;
    }
    if (tabs[next].disabled) return;
    (event.currentTarget as HTMLButtonElement).parentElement
      ?.querySelectorAll<HTMLButtonElement>('button')
      [next]?.focus();
    this.tabChange.emit(tabs[next].value);
  }
}
