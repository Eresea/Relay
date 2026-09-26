import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  model,
  output,
} from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import type { FormValueControl } from "@angular/forms/signals";

let nextId = 0;

@Component({
  selector: "umbra-switch",
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: "./umbra-switch.component.html",
  styleUrl: "./umbra-switch.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "umbra-switch",
    "[attr.data-disabled]": "disabled()",
  },
})
export class UmbraSwitchComponent implements FormValueControl<boolean> {
  readonly value = model(false);
  readonly label = input<string>();
  readonly hint = input<string>();
  readonly error = input<string>();
  readonly disabled = input(false);
  readonly required = input(false);
  readonly invalid = input(false);
  readonly name = input<string>();
  readonly formValue = input("on");
  readonly inputId = input<string>();
  readonly ariaLabel = input<string>();
  readonly ariaLabelledBy = input<string>();
  readonly ariaDescribedBy = input<string>();
  readonly touch = output<void>();

  readonly id = `umbra-switch-${nextId++}`;
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
        .join(" ") || null,
  );

  private readonly host = inject(ElementRef<HTMLElement>);

  onChange(event: Event): void {
    this.value.set((event.target as HTMLInputElement).checked);
  }

  focus(options?: FocusOptions): void {
    const control = this.host.nativeElement.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement | null;
    control?.focus(options);
  }
}
