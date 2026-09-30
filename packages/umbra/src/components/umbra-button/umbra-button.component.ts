import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { Observable, isObservable, lastValueFrom } from 'rxjs';

export type UmbraButtonVariant =
  'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
export type UmbraButtonSize = 'sm' | 'md' | 'lg' | 'icon';
export type UmbraButtonAction = () => void | Promise<void> | Observable<unknown>;

@Component({
  selector: 'umbra-button',
  standalone: true,
  templateUrl: './umbra-button.component.html',
  styleUrl: './umbra-button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': "'umbra-button-host umbra-button-host--' + size()" },
})
export class UmbraButtonComponent {
  readonly variant = input<UmbraButtonVariant>('default');
  readonly size = input<UmbraButtonSize>('md');
  readonly type = input<'button' | 'submit' | 'reset'>('button');
  readonly loading = input(false);
  readonly disabled = input(false);
  readonly loadingLabel = input<string>();
  readonly iconPosition = input<'start' | 'end'>('start');
  readonly progress = input<number | null>(null);
  readonly pressed = input<boolean>();
  readonly action = input<UmbraButtonAction>();
  readonly ariaLabel = input<string>();
  readonly ariaLabelledBy = input<string>();
  readonly ariaDescribedBy = input<string>();
  readonly actionError = output<unknown>();

  private readonly actionLoading = signal(false);
  readonly isLoading = computed(() => this.loading() || this.actionLoading());
  readonly progressValue = computed(() => {
    const value = this.progress();
    return value === null ? null : Math.min(100, Math.max(0, value));
  });
  readonly progressOffset = computed(() =>
    this.progressValue() === null ? null : 100 - this.progressValue()!,
  );

  constructor() {
    effect(() => {
      if (this.size() === 'icon' && !this.ariaLabel() && !this.ariaLabelledBy())
        throw new Error('UmbraButtonComponent: icon buttons require ariaLabel or ariaLabelledBy.');
    });
  }

  runAction(): void {
    if (this.disabled() || this.isLoading()) return;
    const action = this.action();
    if (!action) return;

    const result = action();
    if (isObservable(result)) this.track(lastValueFrom(result));
    else if (result instanceof Promise) this.track(result);
  }

  private track(action: Promise<unknown>): void {
    this.actionLoading.set(true);
    action.then(
      () => this.actionLoading.set(false),
      (error) => {
        this.actionLoading.set(false);
        this.actionError.emit(error);
      },
    );
  }
}
