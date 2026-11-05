import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  TemplateRef,
  ViewChild,
  ViewContainerRef,
  effect,
  inject,
  input,
  model,
} from '@angular/core';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';

let nextDialogId = 0;

@Component({
  selector: 'umbra-dialog',
  standalone: true,
  imports: [CdkTrapFocus],
  template: `
    <span class="trigger" (click)="openFromTrigger($event)"><ng-content select="[umbraDialogTrigger]" /></span>
    <ng-template #dialogTemplate>
      <div class="dialog-layer" (click)="onBackdropClick($event)">
        <section class="dialog-panel"
          [attr.data-size]="size()"
          [id]="panelId" role="dialog" aria-modal="true"
          [attr.aria-label]="heading() ? null : ariaLabel()"
          [attr.aria-labelledby]="heading() ? headingId : null"
          tabindex="-1" cdkTrapFocus [cdkTrapFocusAutoCapture]="true" (click)="$event.stopPropagation()">
          @if (heading()) {
            <header class="overlay-header">
              <h2 [id]="headingId">{{ heading() }}</h2>
              <button type="button" class="overlay-close" [attr.aria-label]="closeLabel()" (click)="open.set(false)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </header>
          }
          <ng-content select="[umbraDialogContent]" />
          <footer class="overlay-footer"><ng-content select="[umbraDialogFooter]" /></footer>
        </section>
      </div>
    </ng-template>
  `,
  styleUrl: './umbra-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'umbra-dialog' },
})
export class UmbraDialogComponent implements AfterViewInit {
  readonly open = model(false);
  /** Names the panel when there is no `heading`. */
  readonly ariaLabel = input<string>();
  /** A visible title; it also names the panel and adds a close button. */
  readonly heading = input<string>();
  readonly closeLabel = input('Close');
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  readonly closeOnBackdropClick = input(true);
  readonly closeOnEscape = input(true);

  readonly panelId = `umbra-dialog-${++nextDialogId}`;
  readonly headingId = `${this.panelId}-heading`;

  @ViewChild('dialogTemplate') private dialogTemplate?: TemplateRef<unknown>;

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly overlay = inject(Overlay);
  private readonly viewContainerRef = inject(ViewContainerRef);
  private readonly destroyRef = inject(DestroyRef);
  private overlayRef?: OverlayRef;
  private viewReady = false;
  private trigger?: HTMLElement;
  private restoreFocusTarget?: HTMLElement;

  constructor() {
    effect(() => {
      if (!this.heading() && !this.ariaLabel())
        throw new Error('UmbraDialogComponent: set heading or ariaLabel to name the panel.');
    });
    this.destroyRef.onDestroy(() => {
      this.dispose(false);
    });
    effect(() => {
      const isOpen = this.open();
      if (!this.viewReady) return;
      if (isOpen) this.attach();
      else this.dispose(true);
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    const triggerHost = this.host.nativeElement.querySelector('[umbraDialogTrigger]') as HTMLElement | null;
    this.trigger = triggerHost?.matches('button, a[href]')
      ? triggerHost
      : (triggerHost?.querySelector<HTMLElement>('button, a[href]') ?? undefined);
    if (this.open()) this.attach();
  }

  protected openFromTrigger(event: MouseEvent): void {
    if (!(event.target instanceof Element) || !event.target.closest('[umbraDialogTrigger]')) return;
    this.restoreFocusTarget = this.trigger;
    this.trigger?.setAttribute('aria-haspopup', 'dialog');
    this.trigger?.setAttribute('aria-expanded', 'true');
    this.trigger?.setAttribute('aria-controls', this.panelId);
    this.open.set(true);
    this.attach();
  }

  protected onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget && this.closeOnBackdropClick()) this.open.set(false);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.closeOnEscape()) {
      event.preventDefault();
      event.stopPropagation();
      this.open.set(false);
    }
  }

  private attach(): void {
    if (this.overlayRef || !this.dialogTemplate) return;
    if (!this.restoreFocusTarget) {
      this.restoreFocusTarget = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : this.trigger;
    }
    const ref = this.overlay.create({
      positionStrategy: this.overlay.position().global().centerHorizontally().centerVertically(),
      scrollStrategy: this.overlay.scrollStrategies.block(),
      hasBackdrop: true,
      backdropClass: 'umbra-scrim',
      panelClass: 'umbra-dialog-overlay-panel',
    });
    this.overlayRef = ref;
    ref.attach(new TemplatePortal(this.dialogTemplate, this.viewContainerRef));
    ref.backdropClick().subscribe(() => {
      if (this.closeOnBackdropClick()) this.open.set(false);
    });
    ref.keydownEvents().subscribe((event) => this.onKeydown(event));
    queueMicrotask(() => {
      if (this.overlayRef === ref) ref.overlayElement.querySelector<HTMLElement>('.dialog-panel')?.focus();
    });
  }

  private dispose(restoreFocus: boolean): void {
    if (!this.overlayRef) return;
    this.overlayRef.dispose();
    this.overlayRef = undefined;
    this.trigger?.setAttribute('aria-expanded', 'false');
    const target = this.restoreFocusTarget ?? this.trigger;
    this.restoreFocusTarget = undefined;
    if (restoreFocus && target?.isConnected) target.focus();
  }
}
