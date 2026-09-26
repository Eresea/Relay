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
import type { FormValueControl } from "@angular/forms/signals";

export type UmbraRadioValue = string | number;
export type UmbraRadioOrientation = "horizontal" | "vertical";

export interface UmbraRadioOption {
  label: string;
  value: UmbraRadioValue;
  hint?: string;
  disabled?: boolean;
}

let nextId = 0;

@Component({
  selector: "umbra-radio-group",
  standalone: true,
  templateUrl: "./umbra-radio-group.component.html",
  styleUrl: "./umbra-radio-group.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "umbra-radio-group",
    "[attr.data-orientation]": "orientation()",
    "[attr.data-disabled]": "disabled()",
  },
})
export class UmbraRadioGroupComponent implements FormValueControl<UmbraRadioValue | null> {
  readonly value = model<UmbraRadioValue | null>(null);
  readonly options = input.required<readonly UmbraRadioOption[]>();
  readonly orientation = input<UmbraRadioOrientation>("vertical");
  readonly label = input<string>();
  readonly hint = input<string>();
  readonly error = input<string>();
  readonly disabled = input(false);
  readonly required = input(false);
  readonly invalid = input(false);
  readonly name = input<string>();
  readonly ariaLabel = input<string>();
  readonly ariaLabelledBy = input<string>();
  readonly ariaDescribedBy = input<string>();
  readonly touch = output<void>();

  readonly id = `umbra-radio-group-${nextId++}`;
  readonly controlName = computed(() => this.name() ?? this.id);
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

  select(value: UmbraRadioValue): void {
    this.value.set(value);
  }

  focus(options?: FocusOptions): void {
    const selected = this.host.nativeElement.querySelector(
      'input[type="radio"]:checked:not(:disabled)',
    ) as HTMLInputElement | null;
    const firstEnabled = this.host.nativeElement.querySelector(
      'input[type="radio"]:not(:disabled)',
    ) as HTMLInputElement | null;
    (selected ?? firstEnabled)?.focus(options);
  }
}
