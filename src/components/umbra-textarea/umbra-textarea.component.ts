import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  effect,
  input,
  model,
  numberAttribute,
  output,
} from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';

let nextId = 0;

@Component({
  selector: 'umbra-textarea',
  standalone: true,
  templateUrl: './umbra-textarea.component.html',
  styleUrl: './umbra-textarea.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'umbra-textarea-host' },
})
export class UmbraTextareaComponent implements FormValueControl<string> {
  readonly value = model('');
  readonly label = input<string>();
  readonly placeholder = input('');
  readonly hint = input<string>();
  readonly error = input<string>();
  readonly rows = input(3, { transform: numberAttribute });
  readonly resize = input<'none' | 'vertical' | 'horizontal' | 'both'>(
    'vertical',
  );
  readonly autoResize = input(false);
  readonly disabled = input(false);
  readonly readonly = input(false);
  readonly required = input(false);
  readonly invalid = input(false);
  readonly showCount = input(false);
  readonly name = input<string>();
  readonly autocomplete = input<string>();
  readonly minLength = input<number>();
  readonly maxLength = input<number>();
  readonly spellcheck = input<boolean>();
  readonly inputId = input<string>();
  readonly ariaLabel = input<string>();
  readonly ariaLabelledBy = input<string>();
  readonly ariaDescribedBy = input<string>();
  readonly touch = output<void>();

  @ViewChild('control') private control?: ElementRef<HTMLTextAreaElement>;

  readonly id = `umbra-textarea-${nextId++}`;
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

  constructor() {
    effect(() => {
      if (this.autoResize()) {
        this.value();
        queueMicrotask(() => this.resizeToContent());
      } else if (this.control) {
        this.control.nativeElement.style.height = '';
      }
    });
  }

  onInput(event: Event): void {
    this.value.set((event.target as HTMLTextAreaElement).value);
    this.resizeToContent();
  }

  resizeToContent(): void {
    if (!this.autoResize() || !this.control) return;
    const control = this.control.nativeElement;
    control.style.height = 'auto';
    control.style.height = `${control.scrollHeight}px`;
  }

  focus(options?: FocusOptions): void {
    this.control?.nativeElement.focus(options);
  }
}
