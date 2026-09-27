import { ChangeDetectionStrategy, Component, ElementRef, QueryList, ViewChildren, input, output } from '@angular/core';

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
})
export class UmbraMenuComponent {
  readonly ariaLabel = input.required<string>();
  readonly items = input<readonly UmbraMenuItem[]>([]);
  readonly selected = output<UmbraMenuItem>();
  readonly dismiss = output<void>();

  @ViewChildren('menuItem') private readonly menuItems!: QueryList<ElementRef<HTMLButtonElement>>;

  protected tabIndex(index: number): 0 | -1 {
    return index === this.items().findIndex(item => !item.disabled) ? 0 : -1;
  }

  protected select(item: UmbraMenuItem): void {
    if (item.disabled) return;
    this.selected.emit(item);
    this.dismiss.emit();
  }

  protected handleKeydown(event: KeyboardEvent): void {
    const buttons = this.menuItems?.toArray().filter(button => !button.nativeElement.disabled) ?? [];
    if (event.key === 'Escape') {
      event.preventDefault();
      this.dismiss.emit();
      return;
    }
    if (!buttons.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = buttons.findIndex(button => button.nativeElement === document.activeElement);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : current < 0
          ? event.key === 'ArrowDown' ? 0 : buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].nativeElement.focus();
  }
}
