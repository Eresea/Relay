import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppPopover, PopoverContent, PopoverTrigger } from './app-popover';

@Component({
  selector: 'rl-popover-test-host',
  imports: [AppPopover, PopoverContent, PopoverTrigger],
  template: `
    <rl-app-popover>
      <button type="button" rlPopoverTrigger>Open</button>
      <div rlPopoverContent>Content</div>
    </rl-app-popover>
  `,
})
class PopoverTestHost {}

describe('AppPopover', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [PopoverTestHost] }));
  afterEach(() => TestBed.resetTestingModule());

  it('toggles projected content and closes on Escape', () => {
    const fixture = TestBed.createComponent(PopoverTestHost);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const trigger = host.querySelector('button') as HTMLButtonElement;
    expect(host.textContent).not.toContain('Content');

    trigger.click();
    fixture.detectChanges();
    expect(host.textContent).toContain('Content');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(host.textContent).not.toContain('Content');
  });
});
