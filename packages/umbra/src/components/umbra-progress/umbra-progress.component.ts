import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";

export type UmbraProgressVariant = "linear" | "circular";

@Component({
  selector: "umbra-progress",
  standalone: true,
  templateUrl: "./umbra-progress.component.html",
  styleUrl: "./umbra-progress.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "umbra-progress",
    "[attr.data-variant]": "variant()",
    role: "progressbar",
    "[attr.aria-label]": "ariaLabel()",
    "[attr.aria-valuemin]": "isIndeterminate() ? null : 0",
    "[attr.aria-valuemax]": "isIndeterminate() ? null : safeMax()",
    "[attr.aria-valuenow]": "isIndeterminate() ? null : clampedValue()",
  },
})
export class UmbraProgressComponent {
  readonly variant = input<UmbraProgressVariant>("linear");
  readonly value = input<number | null>(null);
  readonly max = input(100);
  readonly ariaLabel = input.required<string>();

  readonly isIndeterminate = computed(() => this.value() === null);
  readonly safeMax = computed(() => {
    const max = this.max();
    return Number.isFinite(max) && max > 0 ? max : 100;
  });
  readonly clampedValue = computed(() => {
    const value = this.value();
    if (!Number.isFinite(value)) return 0;
    return Math.min(this.safeMax(), Math.max(0, value ?? 0));
  });
  readonly percent = computed(
    () => (this.clampedValue() / this.safeMax()) * 100,
  );
}
