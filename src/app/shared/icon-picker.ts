import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { AppPopover, PopoverContent, PopoverTrigger } from './app-popover';
import { Icon } from './icon';

const PROJECT_ICONS = [
  'circle',
  'folder',
  'house',
  'library',
  'inbox',
  'file-text',
  'star',
  'square',
  'command',
  'eye',
  'lock',
  'settings',
  'search',
  'download',
  'clock',
  'info',
  'circle-check',
  'circle-alert',
  'triangle-alert',
  'pencil',
  'copy',
  'plus',
  'sun',
  'moon',
  'trash-2',
  'panel-left',
  'arrow-left',
  'ellipsis',
  'x',
] as const;

@Component({
  selector: 'rl-icon-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppPopover, PopoverContent, PopoverTrigger, Icon],
  template: `
    <rl-app-popover>
      <button
        type="button"
        class="trigger"
        rlPopoverTrigger
        [attr.aria-label]="label()"
        [title]="label()"
      >
        <rl-icon [name]="value()" [size]="16" />
      </button>

      <div rlPopoverContent class="picker">
        <div class="picker-header">
          <p class="picker-title">Project icon</p>
          <button type="button" class="clear-button" [disabled]="!query()" (click)="clearFilter()">
            Clear
          </button>
        </div>

        <label class="search-field">
          <rl-icon name="search" [size]="14" />
          <input
            type="search"
            [value]="query()"
            placeholder="Filter icons"
            aria-label="Filter project icons"
            (input)="updateQuery($event)"
          />
        </label>

        @if (filteredIcons().length) {
          <div class="icon-grid" role="listbox" aria-label="Project icons">
            @for (icon of filteredIcons(); track icon) {
              <button
                type="button"
                class="icon-option"
                role="option"
                [class.selected]="icon === value()"
                [attr.aria-selected]="icon === value()"
                [attr.aria-label]="iconLabel(icon)"
                [title]="iconLabel(icon)"
                (click)="selectIcon(icon)"
              >
                <rl-icon [name]="icon" [size]="16" />
              </button>
            }
          </div>
        } @else {
          <p class="empty">No matching icons</p>
        }
      </div>
    </rl-app-popover>
  `,
  styles: `
    :host {
      display: inline-block;
    }

    .trigger {
      display: grid;
      place-items: center;
      inline-size: 28px;
      block-size: 28px;
      color: var(--text-muted);
      border-radius: var(--radius-sm);
      transition:
        color var(--dur-hover) var(--ease-standard),
        background-color var(--dur-hover) var(--ease-standard);
    }

    .trigger:hover {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .picker {
      inline-size: 308px;
      padding: var(--space-4);
    }

    .picker-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      margin-block-end: var(--space-3);
    }

    .picker-title,
    .empty {
      margin: 0;
    }

    .picker-title {
      color: var(--text-body);
      font-size: var(--text-12);
      font-weight: var(--weight-medium);
    }

    .clear-button {
      padding: var(--space-1) var(--space-2);
      color: var(--text-muted);
      border-radius: var(--radius-sm);
      font-size: var(--text-11);
    }

    .clear-button:hover:not(:disabled) {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .clear-button:disabled {
      opacity: 0.45;
    }

    .search-field {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      block-size: var(--control-md);
      padding-inline: var(--space-3);
      color: var(--text-subtle);
      background: var(--bg-sunken);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      transition:
        border-color var(--dur-hover) var(--ease-standard),
        box-shadow var(--dur-hover) var(--ease-standard);
    }

    .search-field:focus-within {
      border-color: var(--border-focus);
      box-shadow: var(--focus-ring);
    }

    .search-field input {
      min-inline-size: 0;
      flex: 1;
      color: var(--text-body);
      background: transparent;
      border: 0;
      outline: 0;
      font-size: var(--text-12);
    }

    .search-field input::placeholder {
      color: var(--text-subtle);
    }

    .icon-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: var(--space-2);
      margin-block-start: var(--space-4);
    }

    .icon-option {
      display: grid;
      place-items: center;
      inline-size: 34px;
      block-size: 30px;
      color: var(--accent);
      border-radius: var(--radius-sm);
      transition: background-color var(--dur-hover) var(--ease-standard);
    }

    .icon-option:hover,
    .icon-option.selected {
      background: var(--tint-selected);
    }

    .icon-option.selected {
      box-shadow: inset 0 0 0 1px var(--border-focus);
    }

    .empty {
      padding-block: var(--space-6);
      color: var(--text-muted);
      font-size: var(--text-12);
      text-align: center;
    }
  `,
})
export class IconPicker {
  readonly value = input('folder');
  readonly label = input('Choose project icon');
  readonly valueChange = output<string>();

  private readonly popover = viewChild.required(AppPopover);
  protected readonly query = signal('');
  protected readonly iconLabel = iconLabel;
  protected readonly filteredIcons = computed(() => {
    const query = this.query().trim().toLowerCase();
    return query
      ? PROJECT_ICONS.filter((icon) => icon.includes(query) || iconLabel(icon).includes(query))
      : PROJECT_ICONS;
  });

  protected updateQuery(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.query.set(event.target.value);
  }

  protected clearFilter(): void {
    this.query.set('');
  }

  protected selectIcon(icon: string): void {
    this.valueChange.emit(icon);
    this.popover().close();
  }
}

function iconLabel(icon: string): string {
  return icon
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
