import type { FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { ModuleRegistry } from '@/core/modules';
import { TauriBridge } from '@/core/tauri';
import { inject } from '@/lib/inject';
import { useLocalSignal, useSignals } from '@/lib/signals';

/** The Modules screen's form for pinning any web address as a module. */
export function PinWebApp({ onPinned }: { onPinned: (moduleId: string) => void }) {
  useSignals();
  const tauri = inject(TauriBridge);
  const registry = inject(ModuleRegistry);
  const name = useLocalSignal('');
  const url = useLocalSignal('');
  const error = useLocalSignal<string | null>(null);
  const busy = useLocalSignal(false);

  const pin = async (event: FormEvent) => {
    event.preventDefault();
    if (!url().trim() || busy()) return;
    busy.set(true);
    error.set(null);
    try {
      const pinned = await tauri.webAppsPin(name(), url());
      await registry.load();
      name.set('');
      url.set('');
      if (pinned) onPinned(`web-${pinned.id}`);
    } catch (cause) {
      error.set(typeof cause === 'string' ? cause : 'Could not pin that address.');
    } finally {
      busy.set(false);
    }
  };

  return (
    <form className="pin-web-app" onSubmit={(event) => void pin(event)} aria-labelledby="pin-title">
      <h2 className="u-caption" id="pin-title">
        Pin a web app
      </h2>
      <p className="intro">
        Any address gets a tab of its own, signed in apart from Relay and from every other app. It
        uses memory only while its tab is open.
      </p>
      <div className="pin-fields">
        <input
          className="pin-input"
          value={name()}
          onChange={(event) => name.set(event.target.value)}
          placeholder="Name (optional)"
          aria-label="Name"
        />
        <input
          className="pin-input url"
          value={url()}
          onChange={(event) => url.set(event.target.value)}
          placeholder="grafana.example.com"
          aria-label="Web address"
          inputMode="url"
        />
        <Button size="sm" type="submit" disabled={busy() || !url().trim()}>
          Pin
        </Button>
      </div>
      {error() && (
        <p className="pin-error" role="alert">
          {error()}
        </p>
      )}
    </form>
  );
}
