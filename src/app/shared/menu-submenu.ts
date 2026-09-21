import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';

import { Icon } from './icon';

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 200;

let nextSubmenuId = 0;

@Directive({
  selector: '[rlSubmenuContent]',
  standalone: true,
})
export class SubmenuContent {}

/** A menu item that opens a nested flyout menu to its side, the way native
 * OS context menus nest categories instead of flattening everything into
 * one long list. Composes inside `rl-app-popover`'s content — nesting one
 * `rl-menu-submenu` inside another's `[rlSubmenuContent]` works too. */
@Component({
  selector: 'rl-menu-submenu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <button
      #trigger
      type="button"
      class="trigger"
      role="menuitem"
      aria-haspopup="menu"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="open() ? panelId : null"
      (click)="onTriggerClick()"
      (mouseenter)="scheduleOpen()"
      (mouseleave)="scheduleClose()"
      (keydown.arrowright)="openNow()"
      (keydown.escape)="close()"
    >
      <span class="label">{{ label() }}</span>
      <rl-icon name="chevron-right" [size]="14" />
    </button>
    @if (open()) {
      <div
        #panel
        [id]="panelId"
        class="panel"
        role="menu"
        tabindex="-1"
        [attr.aria-label]="label()"
        [style]="panelStyle()"
        (mouseenter)="cancelTimers()"
        (mouseleave)="scheduleClose()"
        (keydown.escape)="closeAndFocusTrigger()"
      >
        <ng-content select="[rlSubmenuContent]" />
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      position: relative;
    }

    .trigger {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      inline-size: 100%;
      padding: var(--space-2) var(--space-3);
      color: var(--text-body);
      border-radius: var(--radius-sm);
      text-align: start;
    }

    .trigger:hover,
    .trigger[aria-expanded='true'] {
      color: var(--text-strong);
      background: var(--tint-hover);
    }

    .trigger rl-icon {
      color: var(--text-subtle);
    }

    .panel {
      position: fixed;
      z-index: 4;
      min-inline-size: 190px;
      max-block-size: 360px;
      overflow-y: auto;
      padding: var(--space-2);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-overlay);
      box-shadow: var(--shadow-lg);
    }
  `,
})
export class MenuSubmenu {
  readonly label = input.required<string>();
  readonly panelId = `relay-submenu-${nextSubmenuId++}`;

  protected readonly open = signal(false);
  protected readonly panelStyle = signal<Record<string, string>>({});

  private readonly triggerRef = viewChild<ElementRef<HTMLElement>>('trigger');
  private readonly panelRef = viewChild<ElementRef<HTMLElement>>('panel');
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      if (this.open()) {
        queueMicrotask(() => this.reposition());
      } else {
        this.panelStyle.set({});
      }
    });
    inject(DestroyRef).onDestroy(() => this.cancelTimers());
  }

  protected onTriggerClick(): void {
    this.cancelTimers();
    if (this.open()) this.close();
    else this.openNow();
  }

  protected scheduleOpen(): void {
    this.cancelTimers();
    this.openTimer = setTimeout(() => this.openNow(), OPEN_DELAY_MS);
  }

  protected scheduleClose(): void {
    this.cancelTimers();
    this.closeTimer = setTimeout(() => this.close(), CLOSE_DELAY_MS);
  }

  protected cancelTimers(): void {
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  protected openNow(): void {
    this.cancelTimers();
    this.open.set(true);
  }

  protected close(): void {
    this.cancelTimers();
    this.open.set(false);
  }

  protected closeAndFocusTrigger(): void {
    this.close();
    this.triggerRef()?.nativeElement.focus();
  }

  private reposition(): void {
    const trigger = this.triggerRef()?.nativeElement;
    const panel = this.panelRef()?.nativeElement;
    if (!trigger || !panel) return;

    const margin = 8;
    const gap = 2;
    const triggerRect = trigger.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    let left = triggerRect.right + gap;
    if (left + panelRect.width > window.innerWidth - margin) {
      left = triggerRect.left - gap - panelRect.width;
    }
    left = Math.max(margin, left);

    let top = triggerRect.top;
    if (top + panelRect.height > window.innerHeight - margin) {
      top = window.innerHeight - margin - panelRect.height;
    }
    top = Math.max(margin, top);

    this.panelStyle.set({ position: 'fixed', top: `${top}px`, left: `${left}px` });
  }
}
