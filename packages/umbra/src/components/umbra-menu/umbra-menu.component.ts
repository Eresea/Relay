import { ChangeDetectionStrategy, Component, ElementRef, QueryList, ViewChildren, computed, input, output, signal } from '@angular/core';

export interface UmbraMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  destructive?: boolean;
}

@Component({
  selector: 'umbra-menu',
  standalone: true,
  templateUrl: './umbra-menu.component.html',
  styleUrl: './umbra-menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'umbra-menu' },
})
export class UmbraMenuComponent {
  readonly ariaLabel = input.required<string>();
  readonly items = input<readonly UmbraMenuItem[]>([]);
  readonly selected = output<UmbraMenuItem>();
  readonly dismiss = output<void>();

  @ViewChildren('menuItem') private readonly menuItems!: QueryList<ElementRef<HTMLButtonElement>>;

  private readonly focusedIndex = signal(-1);
  protected readonly tabbableIndex = computed(() => {
    const focused = this.focusedIndex();
    const items = this.items();
    return items[focused] && !items[focused].disabled ? focused : items.findIndex((item) => !item.disabled);
  });

  /** Moves focus into the menu; call it after the consumer's overlay opens. */
  focus(): void {
    this.menuItems?.get(this.tabbableIndex())?.nativeElement.focus();
  }

  protected rememberFocus(index: number): void {
    this.focusedIndex.set(index);
  }

  protected select(item: UmbraMenuItem): void {
    if (item.disabled) return;
    this.selected.emit(item);
    this.dismiss.emit();
  }

  protected handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.dismiss.emit();
      return;
    }
    const buttons = this.menuItems?.toArray().filter((button) => !button.nativeElement.disabled) ?? [];
    if (!buttons.length) return;
    const current = buttons.findIndex((button) => button.nativeElement === document.activeElement);
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const key = event.key.toLocaleLowerCase();
      const ordered = [...buttons.slice(current + 1), ...buttons.slice(0, current + 1)];
      ordered.find((button) => button.nativeElement.textContent?.trim().toLocaleLowerCase().startsWith(key))?.nativeElement.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : current < 0
            ? event.key === 'ArrowDown' ? 0 : buttons.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].nativeElement.focus();
  }
}
