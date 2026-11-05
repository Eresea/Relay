import { NgTemplateOutlet } from '@angular/common';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Directive,
  ElementRef,
  Renderer2,
  SecurityContext,
  TemplateRef,
  computed,
  inject,
  input,
} from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';

export type UmbraTooltipPosition = 'top' | 'right' | 'bottom' | 'left';

let nextId = 0;

@Component({
  selector: 'umbra-tooltip-panel',
  imports: [NgTemplateOutlet],
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './umbra-tooltip-panel.component.html',
  styleUrl: './umbra-tooltip-panel.component.scss',
  host: {
    role: 'tooltip',
    '[attr.id]': 'panelId()',
    '[class.has-template]': '!!template()',
  },
})
export class UmbraTooltipPanelComponent {
  private readonly sanitizer = inject(DomSanitizer);
  readonly text = input.required<string>();
  readonly html = input<string | null>(null);
  readonly panelId = input.required<string>();
  readonly template = input<TemplateRef<unknown> | null>(null);
  readonly sanitizedHtml = computed(() => {
    const value = this.html()?.trim();
    return value ? this.sanitizer.sanitize(SecurityContext.HTML, value) : null;
  });
}

@Directive({
  selector: '[umbraTooltip]',
  standalone: true,
  host: {
    '(mouseenter)': 'onMouseEnter()',
    '(mouseleave)': 'onMouseLeave()',
    '(touchstart)': 'onTouchStart()',
    '(focusin)': 'onFocusIn($event)',
    '(focusout)': 'onFocusOut()',
    '(keydown.escape)': 'hide()',
  },
})
export class UmbraTooltipDirective {
  readonly umbraTooltip = input('');
  readonly tooltipHtml = input<string | null>(null);
  readonly tooltipTemplate = input<TemplateRef<unknown> | null>(null);
  readonly tooltipPosition = input<UmbraTooltipPosition>('top');

  private readonly overlay = inject(Overlay);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly renderer = inject(Renderer2);
  private readonly panelId = `umbra-tooltip-${nextId++}`;
  private overlayRef?: OverlayRef;
  private hovered = false;
  private focused = false;
  private suppressMouseEnter = false;
  private originalDescribedBy: string | null = null;
  private showTimer?: ReturnType<typeof setTimeout>;
  // A hovered tooltip must be dismissible without moving the pointer (WCAG 1.4.13).
  private readonly dismissOnEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.hide();
  };

  constructor() {
    inject(DestroyRef).onDestroy(() => this.dispose());
  }

  onMouseEnter(): void {
    if (this.suppressMouseEnter) {
      this.suppressMouseEnter = false;
      return;
    }
    this.hovered = true;
    const delay = Number.parseFloat(
      getComputedStyle(this.element.nativeElement).getPropertyValue('--dur-tooltip-delay'),
    );
    this.showTimer = setTimeout(() => this.show(), Number.isFinite(delay) ? delay : 0);
  }

  onTouchStart(): void {
    this.suppressMouseEnter = true;
    this.hide();
  }

  onMouseLeave(): void {
    this.hovered = false;
    clearTimeout(this.showTimer);
    if (!this.focused) this.hide();
  }

  onFocusIn(event: FocusEvent): void {
    // A click also focuses its target; only keyboard focus should open a tooltip.
    if (!(event.target as HTMLElement).matches(':focus-visible')) return;
    this.focused = true;
    clearTimeout(this.showTimer);
    this.show();
  }

  onFocusOut(): void {
    this.focused = false;
    if (!this.hovered) this.hide();
  }

  show(): void {
    if (!this.hasContent() || this.overlayRef) return;

    const styles = getComputedStyle(this.element.nativeElement);
    const gap = this.tokenPixels(styles, '--space-3');
    const margin = this.tokenPixels(styles, '--space-4');
    const positionStrategy = this.overlay
      .position()
      .flexibleConnectedTo(this.element)
      .withPositions(this.positions(gap))
      .withPush(true)
      .withViewportMargin(margin);

    this.overlayRef = this.overlay.create({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      disposeOnNavigation: true,
    });

    document.addEventListener('keydown', this.dismissOnEscape);
    const panel = this.overlayRef.attach(
      new ComponentPortal(UmbraTooltipPanelComponent),
    );
    panel.setInput('text', this.content());
    panel.setInput('html', this.tooltipHtml());
    panel.setInput('template', this.tooltipTemplate());
    panel.setInput('panelId', this.panelId);

    const host = this.element.nativeElement;
    this.originalDescribedBy = host.getAttribute('aria-describedby');
    const describedBy = [this.originalDescribedBy, this.panelId]
      .filter(Boolean)
      .join(' ');
    this.renderer.setAttribute(host, 'aria-describedby', describedBy);
  }

  hide(): void {
    clearTimeout(this.showTimer);
    if (!this.overlayRef) return;
    document.removeEventListener('keydown', this.dismissOnEscape);

    this.overlayRef.dispose();
    this.overlayRef = undefined;
    this.restoreDescription();
  }

  private dispose(): void {
    this.hide();
    this.hovered = false;
    this.focused = false;
  }

  private restoreDescription(): void {
    if (this.originalDescribedBy) {
      this.renderer.setAttribute(
        this.element.nativeElement,
        'aria-describedby',
        this.originalDescribedBy,
      );
    } else {
      this.renderer.removeAttribute(
        this.element.nativeElement,
        'aria-describedby',
      );
    }
    this.originalDescribedBy = null;
  }

  private positions(gap: number) {
    const positions = {
      top: {
        originX: 'center',
        originY: 'top',
        overlayX: 'center',
        overlayY: 'bottom',
        offsetY: -gap,
      },
      right: {
        originX: 'end',
        originY: 'center',
        overlayX: 'start',
        overlayY: 'center',
        offsetX: gap,
      },
      bottom: {
        originX: 'center',
        originY: 'bottom',
        overlayX: 'center',
        overlayY: 'top',
        offsetY: gap,
      },
      left: {
        originX: 'start',
        originY: 'center',
        overlayX: 'end',
        overlayY: 'center',
        offsetX: -gap,
      },
    } as const;
    const order: UmbraTooltipPosition[] = [
      this.tooltipPosition(),
      'top',
      'right',
      'bottom',
      'left',
    ];
    return [...new Set(order)].map((position) => positions[position]);
  }

  private content(): string {
    return this.umbraTooltip().trim();
  }

  private hasContent(): boolean {
    return Boolean(this.tooltipTemplate() || this.content() || this.tooltipHtml()?.trim());
  }

  private tokenPixels(styles: CSSStyleDeclaration, token: string): number {
    const value = Number.parseFloat(styles.getPropertyValue(token));
    return Number.isFinite(value) ? value : 0;
  }
}
