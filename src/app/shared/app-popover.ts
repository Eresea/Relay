import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  HostBinding,
  HostListener,
  inject,
  input,
  output,
  signal,
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
      <div [id]="contentId" class="surface" [attr.role]="surfaceRole()">
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
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-overlay);
      box-shadow: var(--shadow-lg);
    }
  `,
})
export class AppPopover {
  readonly open = signal(false);
  readonly openChange = output<boolean>();
  readonly surfaceRole = input<'dialog' | 'menu'>('dialog');
  readonly contentId = `relay-popover-${nextPopoverId++}`;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

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
