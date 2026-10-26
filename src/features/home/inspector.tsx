import type { FormEvent } from 'react';

import { hueFor, hueVar } from '@/core/entity-hue';
import { NexusAccount } from '@/core/nexus-account';
import { TauriBridge, type CodexThreadSummary, type WorkspaceSummary } from '@/core/tauri';
import { ago } from '@/features/palette/omnibar';
import { inject } from '@/lib/inject';
import { signal, useController, useSignals } from '@/lib/signals';
import { vars } from '@/lib/utils';
import { Icon } from '@/shared/icon';

const SHOWN = 4;
const threadTime = (t: CodexThreadSummary) => t.recencyAt ?? t.updatedAt ?? t.createdAt;

/** What the inspector shows: your most recent workspaces and agent threads. */
class InspectorState {
  private readonly tauri = inject(TauriBridge);
  readonly account = inject(NexusAccount);
  readonly workspaces = signal<readonly WorkspaceSummary[]>([]);
  readonly threads = signal<readonly CodexThreadSummary[]>([]);
  readonly prompt = signal('');
  readonly asked = signal<string | null>(null);

  start(): void {
    if (!this.tauri.available) return;
    void this.tauri
      .scanWorkspaces()
      .then((all) =>
        this.workspaces.set(
          [...all].sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0)).slice(0, SHOWN),
        ),
      )
      .catch(() => undefined);
    void this.tauri
      .codexListThreads()
      .then((page) =>
        this.threads.set(
          [...page.threads].sort((a, b) => threadTime(b) - threadTime(a)).slice(0, SHOWN),
        ),
      )
      .catch(() => undefined);
  }

  openFolder(path: string): void {
    void this.tauri.openPath(path);
  }

  /** Asks Codex in the most recently changed workspace; the answer arrives in Today. */
  ask(event: FormEvent): void {
    event.preventDefault();
    const prompt = this.prompt().trim();
    const workspace = this.workspaces()[0];
    if (!prompt || !workspace) return;
    void this.tauri.codexAsk(prompt, workspace.path);
    this.prompt.set('');
    this.asked.set(workspace.name);
  }
}

/** The Deck's right column: context that stays put whichever tab is open. */
export function Inspector({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  useSignals();
  const s = useController(() => new InspectorState());
  const status = s.account.status();
  const workspace = s.workspaces()[0];

  return (
    <aside className="inspector" aria-label="Inspector">
      <section className="sect">
        <h2 className="u-caption">Working set</h2>
        {s.workspaces().length === 0 ? (
          <p className="sect-empty">No workspaces found.</p>
        ) : (
          s.workspaces().map((w) => (
            <button
              key={w.path}
              type="button"
              className="sect-item"
              title={w.path}
              onClick={() => s.openFolder(w.path)}
            >
              <span
                className="u-entity-tile tile"
                style={vars({ '--entity-hue': hueVar(hueFor(w.path)) })}
              >
                <Icon name="folder" size={14} />
              </span>
              <span className="sect-title">{w.name}</span>
              <span className="sect-meta">
                {w.currentBranch ?? (w.modifiedAt ? ago(w.modifiedAt * 1000) : '')}
              </span>
            </button>
          ))
        )}
      </section>

      <section className="sect">
        <h2 className="u-caption">Agents</h2>
        {s.threads().length === 0 ? (
          <p className="sect-empty">No Codex threads yet.</p>
        ) : (
          s.threads().map((t) => (
            <button
              key={t.id}
              type="button"
              className="sect-item"
              onClick={() => onOpenThread(t.id)}
            >
              <span
                className="u-entity-tile tile"
                style={vars({ '--entity-hue': hueVar(hueFor('codex')) })}
              >
                <Icon name="sparkles" size={14} />
              </span>
              <span className="sect-title">{t.name || t.preview || 'Untitled thread'}</span>
              <span className="sect-meta">{ago(threadTime(t) * 1000)}</span>
            </button>
          ))
        )}
      </section>

      <section className="sect">
        <h2 className="u-caption">Account</h2>
        <dl className="kv">
          <dt>Nexus</dt>
          <dd>{status.connected ? 'Connected' : 'Signed out'}</dd>
          {status.connected && (
            <>
              <dt>Signed in as</dt>
              <dd>{status.email || status.displayName || 'Unknown'}</dd>
            </>
          )}
        </dl>
      </section>

      <form className="sect ask" onSubmit={(event) => s.ask(event)}>
        <h2 className="u-caption">Ask</h2>
        <label className="ask-field">
          <Icon name="sparkles" size={14} />
          <input
            value={s.prompt()}
            onChange={(event) => s.prompt.set(event.target.value)}
            placeholder={workspace ? `Ask Codex about ${workspace.name}` : 'Ask Codex'}
            aria-label="Ask Codex"
            disabled={!workspace}
          />
        </label>
        {s.asked() && (
          <p className="sect-empty">Asked in {s.asked()}. The answer arrives in Today.</p>
        )}
      </form>
    </aside>
  );
}
