import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  input,
  model,
  output,
} from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';

let nextId = 0;

@Component({
  selector: 'umbra-slider',
  standalone: true,
  templateUrl: './umbra-slider.component.html',
  styleUrl: './umbra-slider.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'umbra-slider-host' },
})
export class UmbraSliderComponent implements FormValueControl<number> {
  readonly value = model(0);
  readonly min = input(0);
  readonly max = input(100);
  readonly step = input(1);
  readonly label = input<string>();
  readonly hint = input<string>();
  readonly error = input<string>();
  readonly disabled = input(false);
  readonly required = input(false);
  readonly invalid = input(false);
  readonly showValue = input(false);
  readonly name = input<string>();
  readonly inputId = input<string>();
  readonly ariaLabel = input<string>();
  readonly ariaLabelledBy = input<string>();
  readonly ariaDescribedBy = input<string>();
  readonly touch = output<void>();

  @ViewChild('control') private control?: ElementRef<HTMLInputElement>;

  readonly id = `umbra-slider-${nextId++}`;
  readonly controlId = computed(() => this.inputId() ?? this.id);
  readonly hintId = `${this.id}-hint`;
  readonly errorId = `${this.id}-error`;
  readonly hasError = computed(() => this.invalid() || !!this.error());
  readonly percent = computed(() => {
    const min = this.min();
    const max = this.max();
    if (max <= min) return 0;
    return ((Math.min(max, Math.max(min, this.value())) - min) / (max - min)) * 100;
  });
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

  onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).valueAsNumber);
  }

  focus(options?: FocusOptions): void {
    this.control?.nativeElement.focus(options);
  }
}
