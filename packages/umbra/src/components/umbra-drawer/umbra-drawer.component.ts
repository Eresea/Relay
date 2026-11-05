import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnChanges,
  SimpleChanges,
  TemplateRef,
  ViewChild,
  ViewContainerRef,
  effect,
  inject,
  input,
  model,
} from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';

export type UmbraDrawerSide = 'left' | 'right';

const focusableSelector =
  'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let nextDrawerId = 0;

@Component({
  selector: 'umbra-drawer',
  standalone: true,
  templateUrl: './umbra-drawer.component.html',
  styleUrl: './umbra-drawer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'umbra-drawer' },
})
export class UmbraDrawerComponent implements AfterViewInit, OnChanges {
  readonly open = model(false);
  readonly side = input<UmbraDrawerSide>('right');
  readonly mobilePresentation = input<'side' | 'bottom-sheet'>('side');
  /** Names the panel when there is no `heading`. */
  readonly ariaLabel = input<string>();
  /** A visible title; it also names the panel and adds a close button. */
  readonly heading = input<string>();
  readonly closeLabel = input('Close');
  readonly triggerAriaLabel = input<string | null>(null);
  readonly size = input<'sm' | 'md' | 'lg' | 'full'>('md');
  readonly closeOnBackdropClick = input(true);
  readonly closeOnEscape = input(true);
  readonly trapFocus = input(true);

  readonly panelId = `umbra-drawer-${++nextDrawerId}`;
  readonly headingId = `${this.panelId}-heading`;

  @ViewChild('panelTemplate') private panelTemplate?: TemplateRef<unknown>;

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly overlay = inject(Overlay);
  private readonly viewContainerRef = inject(ViewContainerRef);
  private readonly destroyRef = inject(DestroyRef);
  private overlayRef?: OverlayRef;
  private viewReady = false;
  private restoreFocusTarget?: HTMLElement;

  private readonly handleHostClick = (event: MouseEvent): void => {
    const triggerHost = this.triggerHost();
    if (!triggerHost || !(event.target instanceof Node) || !triggerHost.contains(event.target)) return;
    if (this.open()) {
      this.close();
    } else {
      this.restoreFocusTarget = this.triggerElement() ?? undefined;
      this.open.set(true);
      this.syncTriggerAttributes();
      this.attachOverlay();
    }
  };

  constructor() {
    effect(() => {
      if (!this.heading() && !this.ariaLabel())
        throw new Error('UmbraDrawerComponent: set heading or ariaLabel to name the panel.');
    });
    this.destroyRef.onDestroy(() => {
      this.host.nativeElement.removeEventListener('click', this.handleHostClick, true);
      this.overlayRef?.dispose();
    });
    effect(() => {
      const isOpen = this.open();
      if (!this.viewReady) return;
      this.syncTriggerAttributes();
      if (isOpen) this.attachOverlay();
      else {
        const restoreFocus = !!this.overlayRef;
        this.disposeOverlay();
        if (restoreFocus) this.restoreFocus();
      }
    });
  }

  ngAfterViewInit(): void {
    this.host.nativeElement.addEventListener('click', this.handleHostClick, true);
    this.viewReady = true;
    this.syncTriggerAttributes();
    if (this.open()) this.attachOverlay();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.viewReady) return;
    this.syncTriggerAttributes();
    if ((changes['side'] || changes['size'] || changes['mobilePresentation']) && this.open()) {
      this.disposeOverlay();
      this.attachOverlay();
    }
  }

  private attachOverlay(): void {
    if (!this.open() || this.overlayRef) return;
    if (!this.restoreFocusTarget) {
      const activeElement = document.activeElement;
      this.restoreFocusTarget = activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : this.triggerElement() ?? undefined;
    }
    const template = this.panelTemplate;
    if (!template) return;

    const positionStrategy = this.overlay
      .position()
      .global()
      .top('0').left('0').width('100vw').height('100dvh');

    const overlayRef = this.overlay.create({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.block(),
      hasBackdrop: true,
      backdropClass: 'umbra-scrim',
      panelClass: 'umbra-drawer-overlay-panel',
    });

    this.overlayRef = overlayRef;
    overlayRef.attach(new TemplatePortal(template, this.viewContainerRef));

    overlayRef.backdropClick().subscribe(() => {
      if (this.closeOnBackdropClick()) this.close();
    });

    overlayRef.keydownEvents().subscribe((event) => {
      if (event.key === 'Escape' && this.closeOnEscape()) {
        event.preventDefault();
        this.close();
      } else if (this.trapFocus() && event.key === 'Tab') {
        this.handleTabKey(event);
      }
    });

    this.syncTriggerAttributes();
    queueMicrotask(() => {
      if (this.overlayRef !== overlayRef) return;
      const target =
        this.focusableElements().find((element) => element.closest('.drawer-body')) ??
        overlayRef.overlayElement.querySelector<HTMLElement>('.drawer-panel');
      target?.focus();
    });
  }

  private handleTabKey(event: KeyboardEvent): void {
    const focusables = this.focusableElements();
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    const panel = this.overlayRef?.overlayElement.querySelector('.drawer-panel');
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === panel)) {
      event.preventDefault();
      first.focus();
    }
  }

  protected close(): void {
    this.open.set(false);
    this.disposeOverlay();
    this.syncTriggerAttributes();
    this.restoreFocus();
  }

  private restoreFocus(): void {
    const target = this.restoreFocusTarget ?? this.triggerElement();
    this.restoreFocusTarget = undefined;
    if (target?.isConnected) target.focus();
  }

  private disposeOverlay(): void {
    this.overlayRef?.dispose();
    this.overlayRef = undefined;
  }

  private triggerHost(): HTMLElement | null {
    return this.host.nativeElement.querySelector('[umbraDrawerTrigger]') as HTMLElement | null;
  }

  private triggerElement(): HTMLElement | null {
    const triggerHost = this.triggerHost();
    if (!triggerHost) return null;
    return triggerHost.matches('button, a[href], [role="button"]')
      ? triggerHost
      : triggerHost.querySelector<HTMLElement>('button, a[href], [role="button"]') ?? triggerHost;
  }

  private syncTriggerAttributes(): void {
    const trigger = this.triggerElement();
    if (!trigger) return;
    trigger.setAttribute('aria-expanded', String(this.open()));
    trigger.setAttribute('aria-controls', this.panelId);
    trigger.setAttribute('aria-haspopup', 'dialog');
    const label = this.triggerAriaLabel();
    if (label !== null) trigger.setAttribute('aria-label', label);
  }

  private focusableElements(): HTMLElement[] {
    return Array.from(
      this.overlayRef?.overlayElement.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
    ).filter(
      (element) =>
        !element.matches(':disabled') &&
        !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
        element.getClientRects().length > 0,
    );
  }
}
