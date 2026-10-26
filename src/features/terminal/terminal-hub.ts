import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';

import { TauriBridge } from '@/core/tauri';
import { ThemeService } from '@/core/theme';
import { folderName } from '@/features/palette/omnibar';
import { inject } from '@/lib/inject';
import { effect, signal } from '@/lib/signals';

/** One shell as the Terminal tab shows it. */
export interface TerminalTab {
  readonly key: string;
  readonly title: string;
  readonly exited: boolean;
}

interface Session {
  readonly key: string;
  readonly cwd: string | null;
  readonly term: Terminal;
  readonly fit: FitAddon;
  /** Where xterm draws; moved between containers as the tab mounts and unmounts. */
  readonly host: HTMLDivElement;
  id: number | null;
  opened: boolean;
}

/** xterm's colours from Umbra's tokens, read when the theme changes. */
function themeFromTokens(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: token('--bg-app'),
    foreground: token('--text-body'),
    cursor: token('--text-strong'),
    cursorAccent: token('--bg-app'),
    selectionBackground: token('--tint-active') || 'rgba(127, 127, 127, 0.3)',
  };
}

/**
 * The window's terminal sessions. It outlives the Terminal tab: switching
 * tabs detaches a session's drawing surface but keeps its shell and
 * scrollback, so coming back finds everything as it was.
 */
export class TerminalHub {
  private readonly tauri = inject(TauriBridge);
  private readonly theme = inject(ThemeService);
  private readonly sessions = new Map<string, Session>();
  private next = 0;

  readonly tabs = signal<readonly TerminalTab[]>([]);
  readonly active = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      this.theme.theme();
      // Read the tokens once the theme's own effect has restyled the page.
      queueMicrotask(() => {
        const theme = themeFromTokens();
        for (const session of this.sessions.values()) session.term.options.theme = theme;
      });
    });
  }

  /** Adds a session in `cwd` (home when null) and makes it active. */
  add(cwd: string | null): string {
    const key = `t${++this.next}`;
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
      fontSize: 13,
      cursorBlink: true,
      theme: themeFromTokens(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const host = document.createElement('div');
    host.className = 'terminal-host';
    this.sessions.set(key, { key, cwd, term, fit, host, id: null, opened: false });
    this.tabs.update((tabs) => [
      ...tabs,
      { key, title: cwd ? folderName(cwd) : 'Home', exited: false },
    ]);
    this.active.set(key);
    return key;
  }

  /**
   * Shows `key` in `container`. The first time, xterm draws into the page
   * and the shell starts at the size that fits; later, the surface moves.
   */
  attach(key: string, container: HTMLElement): void {
    const session = this.sessions.get(key);
    if (!session) return;
    container.replaceChildren(session.host);
    if (!session.opened) {
      session.opened = true;
      session.term.open(session.host);
      session.fit.fit();
      void this.start(session);
    } else {
      session.fit.fit();
    }
    session.term.focus();
  }

  /** Refits the active session to its container, after the tab resizes. */
  fit(): void {
    const session = this.sessions.get(this.active() ?? '');
    if (session?.opened) session.fit.fit();
  }

  private async start(session: Session): Promise<void> {
    const { term } = session;
    try {
      const info = await this.tauri.terminalOpen(session.cwd, term.cols, term.rows, (output) => {
        if (output.kind === 'data') {
          term.write(output.data);
          return;
        }
        term.write(
          `\r\n\x1b[2m[exited${output.code === null ? '' : ` with code ${output.code}`}]\x1b[0m\r\n`,
        );
        session.id = null;
        this.tabs.update((tabs) =>
          tabs.map((tab) => (tab.key === session.key ? { ...tab, exited: true } : tab)),
        );
      });
      if (!info) {
        term.write('Terminals need the Relay app; this window has no core behind it.\r\n');
        return;
      }
      session.id = info.id;
      term.onData((data) => {
        if (session.id !== null) void this.tauri.terminalWrite(session.id, data);
      });
      term.onResize(({ cols, rows }) => {
        if (session.id !== null) void this.tauri.terminalResize(session.id, cols, rows);
      });
      this.error.set(null);
    } catch (cause) {
      const message = typeof cause === 'string' ? cause : 'Could not start a shell.';
      this.error.set(message);
      term.write(`${message}\r\n`);
    }
  }

  /** Ends the session's shell and forgets it. */
  close(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    if (session.id !== null) void this.tauri.terminalClose(session.id);
    session.term.dispose();
    session.host.remove();
    this.sessions.delete(key);
    const tabs = this.tabs().filter((tab) => tab.key !== key);
    this.tabs.set(tabs);
    if (this.active() === key) this.active.set(tabs.at(-1)?.key ?? null);
  }
}
