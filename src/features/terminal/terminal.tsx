import '@xterm/xterm/css/xterm.css';

import { useEffect, useRef } from 'react';

import { TauriBridge, type WorkspaceSummary } from '@/core/tauri';
import { inject } from '@/lib/inject';
import { useLocalSignal, useSignals } from '@/lib/signals';
import { cn } from '@/lib/utils';
import { Icon } from '@/shared/icon';

import { TerminalHub } from './terminal-hub';
import './terminal.css';

/**
 * The Terminal tab: shells side by side as tabs of their own, each in a
 * folder of your choosing. The sessions belong to the window (TerminalHub),
 * so leaving this tab keeps them running.
 */
export default function TerminalView() {
  useSignals();
  const hub = inject(TerminalHub);
  const tauri = inject(TauriBridge);
  const surface = useRef<HTMLDivElement>(null);
  const workspaces = useLocalSignal<readonly WorkspaceSummary[]>([]);
  const active = hub.active();

  // A first visit opens a shell at once, as a terminal app would.
  useEffect(() => {
    if (hub.tabs().length === 0) hub.add(null);
    void tauri
      .scanWorkspaces()
      .then((all) => workspaces.set(all))
      .catch(() => undefined);
  }, [hub, tauri, workspaces]);

  useEffect(() => {
    if (active && surface.current) hub.attach(active, surface.current);
  }, [hub, active]);

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const observer = new ResizeObserver(() => hub.fit());
    observer.observe(element);
    return () => observer.disconnect();
  }, [hub]);

  return (
    <section className="terminal" aria-label="Terminal">
      <header className="terminal-bar">
        <div className="sessions" role="tablist" aria-label="Shells">
          {hub.tabs().map((tab) => (
            <div
              key={tab.key}
              className={cn('session', tab.key === active && 'on', tab.exited && 'exited')}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button === 1) hub.close(tab.key);
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.key === active}
                className="session-open"
                onClick={() => hub.active.set(tab.key)}
              >
                <Icon name="terminal" size={14} />
                {tab.title}
              </button>
              <button
                type="button"
                className="session-close"
                aria-label={`Close ${tab.title}`}
                onClick={() => hub.close(tab.key)}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="new"
          aria-label="New shell in your home folder"
          title="New shell"
          onClick={() => hub.add(null)}
        >
          <Icon name="plus" size={14} />
        </button>
        {workspaces().length > 0 && (
          <select
            className="open-in"
            aria-label="New shell in a workspace"
            value=""
            onChange={(event) => {
              if (event.target.value) hub.add(event.target.value);
            }}
          >
            <option value="">Open in…</option>
            {workspaces().map((w) => (
              <option key={w.path} value={w.path}>
                {w.name}
              </option>
            ))}
          </select>
        )}
      </header>
      {/* Always mounted, so the resize observer has something to watch. */}
      <div className="surface" ref={surface} hidden={hub.tabs().length === 0} />
      {hub.tabs().length === 0 && <p className="empty">No shells open. Start one with +.</p>}
    </section>
  );
}
