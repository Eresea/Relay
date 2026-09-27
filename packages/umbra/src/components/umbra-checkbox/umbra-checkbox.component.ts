import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  model,
  output,
} from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';

let nextId = 0;

@Component({
  selector: 'umbra-checkbox',
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: './umbra-checkbox.component.html',
  styleUrl: './umbra-checkbox.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'umbra-checkbox',
    '[attr.data-disabled]': 'disabled()',
  },
})
export class UmbraCheckboxComponent implements FormValueControl<boolean> {
  readonly value = model(false);
  readonly indeterminate = model(false);
  readonly threeState = input(false);
  readonly label = input<string>();
  readonly hint = input<string>();
  readonly error = input<string>();
  readonly disabled = input(false);
  readonly required = input(false);
  readonly invalid = input(false);
  readonly name = input('');
  readonly formValue = input('on');
  readonly inputId = input<string>();
  readonly ariaLabel = input<string>();
  readonly ariaLabelledBy = input<string>();
  readonly ariaDescribedBy = input<string>();
  readonly touch = output<void>();

  readonly id = `umbra-checkbox-${nextId++}`;
  readonly controlId = computed(() => this.inputId() ?? this.id);
  readonly hintId = `${this.id}-hint`;
  readonly errorId = `${this.id}-error`;
  readonly hasError = computed(() => this.invalid() || !!this.error());
  readonly describedBy = computed(
    () =>
      [
        this.ariaDescribedBy(),
        this.error() ? this.errorId : undefined,
        !this.error() && this.hint() ? this.hintId : undefined,
      ]
        .filter(Boolean)
        .join(' ') || null,
  );

  private readonly host = inject(ElementRef<HTMLElement>);

  onChange(event: Event): void {
    const control = event.target as HTMLInputElement;
    if (this.threeState()) {
      if (this.indeterminate()) {
        control.checked = false;
        this.indeterminate.set(false);
        this.value.set(false);
      } else if (this.value()) {
        control.checked = false;
        control.indeterminate = true;
        this.value.set(false);
        this.indeterminate.set(true);
      } else {
        this.value.set(true);
      }
      return;
    }
    this.value.set(control.checked);
    this.indeterminate.set(false);
  }

  focus(options?: FocusOptions): void {
    const control = this.host.nativeElement.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement | null;
    control?.focus(options);
  }
}
