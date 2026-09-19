import { Injectable, effect, signal } from '@angular/core';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'relay.theme';

/**
 * Dark is the default. Light is a complete mirror of every semantic token,
 * opted into with data-theme="light" on <html>.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly current = signal<Theme>(read());

  readonly theme = this.current.asReadonly();

  constructor() {
    effect(() => {
      const theme = this.current();
      document.documentElement.dataset['theme'] = theme;
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // Private mode or blocked storage: the theme simply does not persist.
      }
    });
  }

  set(theme: Theme): void {
    this.current.set(theme);
  }

  toggle(): void {
    this.current.update((t) => (t === 'dark' ? 'light' : 'dark'));
  }
}

function read(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // Fall through to the default.
  }
  return 'dark';
}
