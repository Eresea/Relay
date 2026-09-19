import { Injectable, effect, inject, signal } from '@angular/core';

import { TauriBridge } from './tauri';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'relay.theme';
const SETTING_KEY = 'theme';

/**
 * Dark is the default. Light is a complete mirror of every semantic token,
 * opted into with data-theme="light" on <html>.
 *
 * Persisted twice, deliberately. `localStorage` is read synchronously at
 * construction so the right theme paints before first frame — an IPC round
 * trip to the settings store here would risk a dark-then-light flash on
 * every cold start. The settings store (`settings.json`, via `TauriBridge`)
 * is reconciled once asynchronously right after: it is the durable copy that
 * survives a cleared browser cache and the one another window's first launch
 * reads from before it has any `localStorage` of its own.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly tauri = inject(TauriBridge);
  private readonly current = signal<Theme>(readCache());

  readonly theme = this.current.asReadonly();

  constructor() {
    void this.tauri.getSetting<Theme>(SETTING_KEY, this.current()).then((stored) => {
      if (stored !== this.current()) this.current.set(stored);
    });

    effect(() => {
      const theme = this.current();
      document.documentElement.dataset['theme'] = theme;
      writeCache(theme);
      void this.tauri.setSetting(SETTING_KEY, theme);
    });
  }

  set(theme: Theme): void {
    this.current.set(theme);
  }

  toggle(): void {
    this.current.update((t) => (t === 'dark' ? 'light' : 'dark'));
  }
}

function readCache(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // Fall through to the default.
  }
  return 'dark';
}

function writeCache(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private mode or blocked storage: the fast-path cache does not persist
    // locally, but the settings store write above is still attempted.
  }
}
