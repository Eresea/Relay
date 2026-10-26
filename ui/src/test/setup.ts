import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import { resetInjector } from '@/lib/inject';

// jsdom has no layout: give the observers and scrolling Radix and the screens
// reach for inert stand-ins.
class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}
globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= function releasePointerCapture() {};

afterEach(() => {
  cleanup();
  resetInjector();
  vi.clearAllMocks();
});
