import { useEffect, useRef, useState } from 'react';

import { TauriBridge } from '@/core/tauri';
import { inject } from '@/lib/inject';

import './web-app-view.css';

/**
 * A pinned web app's tab. The page itself is a native webview the core lays
 * over this element; the element only holds the space and reports where it
 * is. Leaving the tab hides the webview (it keeps running); closing the tab
 * is what destroys it.
 */
export default function WebAppView({ id, name }: { id: string; name: string }) {
  const tauri = inject(TauriBridge);
  const frame = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const place = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      tauri
        .webAppsShow(id, { x, y, width, height })
        .then(() => setError(null))
        .catch((cause: unknown) =>
          setError(typeof cause === 'string' ? cause : `Could not open ${name}.`),
        );
    };
    place();
    // The webview is not in the page, so it follows by hand: on resize of
    // this element and of the window (the element can move without resizing).
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      void tauri.webAppsHide(id);
    };
  }, [tauri, id, name]);

  return (
    <section className="web-app" aria-label={name}>
      <div className="web-app-frame" ref={frame}>
        <p className="web-app-note" role={error ? 'alert' : undefined}>
          {error ?? (tauri.available ? `Opening ${name}…` : 'Pinned web apps need the Relay app.')}
        </p>
      </div>
    </section>
  );
}
