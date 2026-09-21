import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IconPicker } from './icon-picker';

describe('IconPicker', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [IconPicker] }));
  afterEach(() => TestBed.resetTestingModule());

  it('filters the catalog and emits the selected icon', () => {
    const fixture = TestBed.createComponent(IconPicker);
    let selected = '';
    fixture.componentInstance.valueChange.subscribe((icon) => (selected = icon));
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    (host.querySelector('[rlPopoverTrigger]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const filter = host.querySelector('input[type="search"]') as HTMLInputElement;
    filter.value = 'star';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();

    const options = host.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(1);
    expect(options[0].getAttribute('aria-label')).toBe('Star');

    (options[0] as HTMLButtonElement).click();
    expect(selected).toBe('star');
  });
});
