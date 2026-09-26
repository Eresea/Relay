import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';

let nextId = 0;

export type UmbraInputType =
  | 'text'
  | 'email'
  | 'password'
  | 'search'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'datetime-local'
  | 'month'
  | 'color'
  | 'time'
  | 'week';

@Component({
  selector: 'umbra-input',
  standalone: true,
  templateUrl: './umbra-input.component.html',
  styleUrl: './umbra-input.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'umbra-input-host',
    '[attr.data-type]': 'type()',
  },
})
export class UmbraInputComponent implements FormValueControl<string> {
  readonly value = model('');
  readonly type = input<UmbraInputType>('text');
  readonly label = input<string>();
  readonly placeholder = input('');
  readonly hint = input<string>();
  readonly error = input<string>();
  readonly disabled = input(false);
  readonly readonly = input(false);
  readonly required = input(false);
  readonly invalid = input(false);
  readonly showClear = input(false);
  readonly showCount = input(false);
  readonly name = input<string>();
  readonly autocomplete = input<string>();
  readonly inputMode = input<string>();
  readonly minLength = input<number>();
  readonly maxLength = input<number>();
  readonly nativeMin = input<string | number | undefined>(undefined, {
    alias: 'min',
  });
  readonly nativeMax = input<string | number | undefined>(undefined, {
    alias: 'max',
  });
  readonly step = input<string | number>();
  readonly nativePattern = input<string | undefined>(undefined, {
    alias: 'pattern',
  });
  readonly spellcheck = input<boolean>();
  readonly inputId = input<string>();
  readonly ariaLabel = input<string>();
  readonly ariaLabelledBy = input<string>();
  readonly ariaDescribedBy = input<string>();
  readonly clearLabel = input('Clear input');
  readonly passwordLabel = input('Show password');
  readonly touch = output<void>();
  readonly enter = output<void>();

  @ViewChild('control') private control?: ElementRef<HTMLInputElement>;

  readonly id = `umbra-input-${nextId++}`;
  readonly controlId = computed(() => this.inputId() ?? this.id);
  readonly hintId = `${this.id}-hint`;
  readonly errorId = `${this.id}-error`;
  readonly countId = `${this.id}-count`;
  readonly hasError = computed(() => this.invalid() || !!this.error());
  readonly describedBy = computed(
    () =>
      [
        this.ariaDescribedBy(),
        this.error() ? this.errorId : undefined,
        !this.error() && this.hint() ? this.hintId : undefined,
        this.showCount() ? this.countId : undefined,
      ]
        .filter(Boolean)
        .join(' ') || null,
  );
  readonly visibleType = computed(() =>
    this.type() === 'password' && this.passwordVisible() ? 'text' : this.type(),
  );
  readonly passwordVisible = signal(false);

  onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') this.enter.emit();
  }

  clear(): void {
    this.value.set('');
    this.touch.emit();
    this.focus();
  }

  togglePassword(): void {
    this.passwordVisible.update((visible) => !visible);
    this.focus();
  }

  focus(options?: FocusOptions): void {
    this.control?.nativeElement.focus(options);
  }
}
