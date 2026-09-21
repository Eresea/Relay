import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  effect,
  ElementRef,
  HostBinding,
  HostListener,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

let nextPopoverId = 0;

@Directive({
  selector: '[rlPopoverTrigger]',
  standalone: true,
})
export class PopoverTrigger {
  private readonly popover = inject(AppPopover);

  @HostBinding('attr.aria-expanded')
  protected get expanded(): boolean {
    return this.popover.open();
  }

  @HostBinding('attr.aria-controls')
  protected get controls(): string {
    return this.popover.contentId;
  }

  @HostBinding('attr.aria-haspopup')
  protected get hasPopup(): 'dialog' | 'menu' {
    return this.popover.surfaceRole();
  }

  @HostListener('click')
  protected toggle(): void {
    this.popover.toggle();
  }
}

@Directive({
  selector: '[rlPopoverContent]',
  standalone: true,
})
export class PopoverContent {}

@Component({
  selector: 'rl-app-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-content select="[rlPopoverTrigger]" />
    @if (open()) {
      <div
        #surface
        [id]="contentId"
        class="surface"
        [class.align-end]="alignEnd()"
        [class.flip-up]="flipUp()"
        [attr.role]="surfaceRole()"
      >
        <ng-content select="[rlPopoverContent]" />
      </div>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: inline-block;
    }

    .surface {
      position: absolute;
      z-index: 3;
      inset-block-start: calc(100% + 5px);
      inset-inline-start: 0;
      overflow: hidden;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-overlay);
      box-shadow: var(--shadow-lg);
    }

    .surface.align-end {
      inset-inline-start: auto;
      inset-inline-end: 0;
    }

    .surface.flip-up {
      inset-block-start: auto;
      inset-block-end: calc(100% + 5px);
    }
  `,
})
export class AppPopover {
  readonly open = signal(false);
  readonly openChange = output<boolean>();
  readonly surfaceRole = input<'dialog' | 'menu'>('dialog');
  readonly contentId = `relay-popover-${nextPopoverId++}`;
  protected readonly alignEnd = signal(false);
  protected readonly flipUp = signal(false);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly surface = viewChild<ElementRef<HTMLElement>>('surface');

  constructor() {
    effect(() => {
      if (this.open()) {
        queueMicrotask(() => this.reposition());
      } else {
        this.alignEnd.set(false);
        this.flipUp.set(false);
      }
    });
  }

  toggle(): void {
    this.setOpen(!this.open());
  }

  close(): void {
    this.setOpen(false);
  }

  private setOpen(value: boolean): void {
    if (this.open() === value) return;
    this.open.set(value);
    this.openChange.emit(value);
  }

  private reposition(): void {
    const el = this.surface()?.nativeElement;
    if (!el) return;
    const margin = 8;
    const rect = el.getBoundingClientRect();
    this.alignEnd.set(rect.right > window.innerWidth - margin);
    this.flipUp.set(rect.bottom > window.innerHeight - margin);
  }

  @HostListener('document:click', ['$event'])
  protected closeOnOutsideClick(event: MouseEvent): void {
    if (!this.open()) return;
    if (!(event.target instanceof Node) || !this.host.nativeElement.contains(event.target)) {
      this.close();
    }
  }

  @HostListener('document:keydown.escape')
  protected closeOnEscape(): void {
    this.close();
  }
}
