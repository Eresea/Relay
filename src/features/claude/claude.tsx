import { useEffect, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { TauriBridge, type ClaudeSession, type ClaudeSessionSummary } from '@/core/tauri';
import { ago, folderName } from '@/features/palette/omnibar';
import { inject } from '@/lib/inject';
import { signal, useController, useSignals } from '@/lib/signals';
import { cn } from '@/lib/utils';
import { Icon } from '@/shared/icon';
import { renderMarkdown } from '@/shared/markdown';

import './claude.css';

const message = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : fallback;

/** Claude Code sessions, read from Claude Code's own transcripts by the core. */
class ClaudeState {
  private readonly tauri = inject(TauriBridge);

  readonly sessions = signal<readonly ClaudeSessionSummary[]>([]);
  readonly listError = signal<string | null>(null);
  readonly loading = signal(true);
  readonly session = signal<ClaudeSession | null>(null);
  readonly sessionError = signal<string | null>(null);
  readonly reply = signal('');
  readonly sending = signal(false);
  readonly sendError = signal<string | null>(null);
  /** The turn in flight: a job, which reports through notifications. */
  private pending: { readonly jobId: string; readonly sessionId: string } | null = null;

  /** Loads sessions and listens for the in-flight turn to finish; returns the disposer. */
  start(): () => void {
    void this.loadSessions();
    const stop = this.tauri.onEvent((event) => {
      if (event.type === 'notificationDone' && event.jobId === this.pending?.jobId) {
        void this.finish(event.ok);
      }
    });
    return () => void stop.then((unlisten) => unlisten());
  }

  async loadSessions(): Promise<void> {
    try {
      this.sessions.set(await this.tauri.claudeListSessions());
      this.listError.set(null);
    } catch (cause) {
      this.listError.set(message(cause, 'Could not read Claude Code sessions.'));
    } finally {
      this.loading.set(false);
    }
  }

  async open(id: string): Promise<void> {
    this.sessionError.set(null);
    this.sendError.set(null);
    try {
      this.session.set(await this.tauri.claudeReadSession(id));
    } catch (cause) {
      this.session.set(null);
      this.sessionError.set(message(cause, 'Could not read that session.'));
    }
  }

  /** Resumes the open session in its own folder, then re-reads the transcript. */
  async send(event: FormEvent): Promise<void> {
    event.preventDefault();
    const session = this.session();
    const prompt = this.reply().trim();
    if (!session || !prompt || this.sending()) return;
    this.sending.set(true);
    this.sendError.set(null);
    try {
      const jobId = await this.tauri.claudeAsk(prompt, session.cwd, session.id);
      if (!jobId) throw new Error('Claude Code is not available here.');
      this.pending = { jobId, sessionId: session.id };
      this.reply.set('');
    } catch (cause) {
      this.sendError.set(message(cause, 'Claude Code could not start.'));
      this.sending.set(false);
    }
  }

  private async finish(ok: boolean): Promise<void> {
    const sessionId = this.pending?.sessionId;
    this.pending = null;
    this.sending.set(false);
    if (!ok) this.sendError.set('Claude could not finish this turn. Today says why.');
    if (sessionId) await this.open(sessionId);
    void this.loadSessions();
  }
}

/**
 * The Claude tab: your Claude Code sessions, newest first, and the open one's
 * conversation with a reply box. New sessions start from the Omnibar's Ask.
 */
export default function Claude({
  openSessionId,
  onSessionHandled,
}: {
  openSessionId: string | null;
  onSessionHandled: () => void;
}) {
  useSignals();
  const s = useController(() => new ClaudeState());

  useEffect(() => {
    if (!openSessionId) return;
    void s.open(openSessionId).then(onSessionHandled);
  }, [s, openSessionId, onSessionHandled]);

  const session = s.session();

  return (
    <section className="claude" aria-labelledby="claude-title">
      <header className="panehead">
        <h1 id="claude-title">Claude Code</h1>
        <span className="count">{s.sessions().length} recent sessions</span>
        <Button size="sm" variant="ghost" className="refresh" onClick={() => void s.loadSessions()}>
          Refresh
        </Button>
      </header>

      <div className="claude-body">
        <nav className="sessions" aria-label="Sessions">
          {s.listError() && (
            <p className="note" role="alert">
              {s.listError()}
            </p>
          )}
          {!s.loading() && !s.listError() && s.sessions().length === 0 && (
            <p className="note">
              No Claude Code sessions yet. Ask Claude from the Omnibar, or start one in a terminal.
            </p>
          )}
          {s.sessions().map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn('session', session?.id === item.id && 'on')}
              aria-current={session?.id === item.id}
              onClick={() => void s.open(item.id)}
            >
              <span className="session-title">{item.title}</span>
              <span className="session-meta">
                {folderName(item.cwd) || 'No folder'} · {ago(item.updatedAt * 1000)}
              </span>
            </button>
          ))}
        </nav>

        <article className="conversation" aria-label="Conversation">
          {s.sessionError() && (
            <p className="note" role="alert">
              {s.sessionError()}
            </p>
          )}
          {session ? (
            <>
              <header className="conversation-head">
                <h2>{session.title}</h2>
                <p className="session-meta">
                  <Icon name="folder" size={14} />
                  {session.cwd}
                </p>
              </header>
              <div className="messages">
                {session.messages.map((m, index) => (
                  <div key={index} className={cn('message', m.role)}>
                    <span className="who">{m.role === 'user' ? 'You' : 'Claude'}</span>
                    {m.role === 'user' ? (
                      <p className="plain">{m.text}</p>
                    ) : (
                      <div
                        className="markdown"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
                      />
                    )}
                  </div>
                ))}
              </div>
              <form className="compose" onSubmit={(event) => void s.send(event)}>
                <textarea
                  value={s.reply()}
                  onChange={(event) => s.reply.set(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Continue this session"
                  aria-label="Reply to Claude"
                  rows={2}
                  disabled={s.sending()}
                />
                <div className="compose-foot">
                  <span className="hint">
                    {s.sendError() ??
                      (s.sending()
                        ? 'Claude is working. Its questions appear in the activity stack.'
                        : 'Edits and commands wait for your Allow in the activity stack.')}
                  </span>
                  <Button size="sm" type="submit" disabled={s.sending() || !s.reply().trim()}>
                    Send
                  </Button>
                </div>
              </form>
            </>
          ) : (
            !s.sessionError() && <p className="note">Pick a session to read it here.</p>
          )}
        </article>
      </div>
    </section>
  );
}
