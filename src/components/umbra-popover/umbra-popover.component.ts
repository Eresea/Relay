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
  inject,
  input,
  model,
  effect,
} from '@angular/core';
import { ConnectedPosition, Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';

export type UmbraPopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

const focusableSelector =
  'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let nextPopoverId = 0;

@Component({
  selector: 'umbra-popover',
  standalone: true,
  templateUrl: './umbra-popover.component.html',
  styleUrl: './umbra-popover.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'umbra-popover' },
})
export class UmbraPopoverComponent implements AfterViewInit, OnChanges {
  readonly open = model(false);
  readonly placement = input<UmbraPopoverPlacement>('bottom-start');
  readonly ariaLabel = input.required<string>();
  readonly triggerAriaLabel = input<string | null>(null);
  readonly triggerHaspopup = input<'dialog' | 'listbox' | 'menu' | null>('dialog');

  readonly panelId = `umbra-popover-${++nextPopoverId}`;

  @ViewChild('panelTemplate') private panelTemplate?: TemplateRef<unknown>;

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly overlay = inject(Overlay);
  private readonly viewContainerRef = inject(ViewContainerRef);
  private readonly destroyRef = inject(DestroyRef);
  private overlayRef?: OverlayRef;
  private viewReady = false;
  private readonly handleHostClick = (event: MouseEvent): void => {
    const triggerHost = this.triggerHost();
    if (!triggerHost || !(event.target instanceof Node) || !triggerHost.contains(event.target)) return;
    if (this.open()) {
      this.close();
    } else {
      this.open.set(true);
      this.syncTriggerAttributes();
      this.attachOverlay();
    }
  };

  constructor() {
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
        const restoreFocus = this.overlayRef?.overlayElement.contains(document.activeElement) ?? false;
        this.disposeOverlay();
        if (restoreFocus) this.triggerElement()?.focus();
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
    if (changes['placement'] && this.open()) {
      this.disposeOverlay();
      this.attachOverlay();
    }
  }

  private attachOverlay(): void {
    if (!this.open() || this.overlayRef) return;
    const trigger = this.triggerElement();
    const template = this.panelTemplate;
    if (!trigger || !template) return;

    const styles = getComputedStyle(trigger);
    const gap = this.tokenPixels(styles, '--space-3');
    const margin = this.tokenPixels(styles, '--space-4');
    const positionStrategy = this.overlay
      .position()
      .flexibleConnectedTo(trigger)
      .withPositions(this.positions(gap))
      .withPush(true)
      .withViewportMargin(margin);
    const overlayRef = this.overlay.create({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
    });
    this.overlayRef = overlayRef;
    overlayRef.attach(new TemplatePortal(template, this.viewContainerRef));
    overlayRef.outsidePointerEvents().subscribe(() => this.close());
    overlayRef.keydownEvents().subscribe((event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close(true);
      } else if (event.key === 'Tab' && event.shiftKey && this.isFirstFocusableFocused()) {
        event.preventDefault();
        this.close(true);
      } else if (event.key === 'Tab' && !event.shiftKey && this.isLastFocusableFocused()) {
        const next = this.nextFocusableAfterHost();
        if (next) {
          event.preventDefault();
          this.close();
          next.focus();
        }
      }
    });
    this.syncTriggerAttributes();
    queueMicrotask(() => {
      if (this.overlayRef !== overlayRef) return;
      const target =
        this.focusableElements()[0] ?? overlayRef.overlayElement.querySelector<HTMLElement>('.popover-panel');
      target?.focus();
    });
  }

  private positions(gap: number): ConnectedPosition[] {
    const [originY, originX] = this.placement().split('-') as ['bottom' | 'top', 'start' | 'end'];
    const oppositeY = originY === 'bottom' ? 'top' : 'bottom';
    const makePosition = (vertical: 'bottom' | 'top'): ConnectedPosition => ({
      originX,
      originY: vertical,
      overlayX: originX,
      overlayY: vertical === 'bottom' ? 'top' : 'bottom',
      offsetY: vertical === 'bottom' ? gap : -gap,
    });
    return [makePosition(originY), makePosition(oppositeY)];
  }

  close(restoreFocus = false): void {
    this.open.set(false);
    this.disposeOverlay();
    this.syncTriggerAttributes();
    if (restoreFocus) this.triggerElement()?.focus();
  }

  private disposeOverlay(): void {
    this.overlayRef?.dispose();
    this.overlayRef = undefined;
  }

  private triggerHost(): HTMLElement | null {
    return this.host.nativeElement.querySelector('[umbraPopoverTrigger]') as HTMLElement | null;
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
    this.setOptionalAttribute(trigger, 'aria-haspopup', this.triggerHaspopup());
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

  private isFirstFocusableFocused(): boolean {
    const first = this.focusableElements()[0];
    const panel = this.overlayRef?.overlayElement.querySelector<HTMLElement>('.popover-panel');
    return document.activeElement === first || (!first && document.activeElement === panel);
  }

  private isLastFocusableFocused(): boolean {
    const focusables = this.focusableElements();
    return focusables.length > 0
      ? document.activeElement === focusables[focusables.length - 1]
      : document.activeElement === this.overlayRef?.overlayElement.querySelector('.popover-panel');
  }

  private nextFocusableAfterHost(): HTMLElement | undefined {
    const host = this.host.nativeElement;
    return Array.from(
      document.querySelectorAll<HTMLElement>(focusableSelector),
    ).find((element) => {
      if (element.closest('.cdk-overlay-container') || element.getClientRects().length === 0) return false;
      return Boolean(host.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
  }

  private setOptionalAttribute(element: HTMLElement, name: string, value: string | null): void {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  private tokenPixels(styles: CSSStyleDeclaration, token: string): number {
    const value = Number.parseFloat(styles.getPropertyValue(token));
    return Number.isFinite(value) ? value : 0;
  }
}
