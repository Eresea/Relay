import { expect, it, vi } from 'vitest';

import type { TerminalOutput } from '@/core/tauri';
import { ThemeService } from '@/core/theme';
import { provide } from '@/lib/inject';
import { signal } from '@/lib/signals';
import { provideBridge } from '@/test/bridge';

import { TerminalHub } from './terminal-hub';

/** jsdom cannot draw a terminal; this records what would reach the screen. */
const { FakeTerminal } = vi.hoisted(() => {
  class FakeTerminal {
    static made: FakeTerminal[] = [];
    cols = 80;
    rows = 24;
    options = {};
    written: string[] = [];
    typed: ((data: string) => void) | null = null;
    constructor() {
      FakeTerminal.made.push(this);
    }
    open() {}
    focus() {}
    dispose() {}
    loadAddon() {}
    write(data: string) {
      this.written.push(data);
    }
    onData(listener: (data: string) => void) {
      this.typed = listener;
    }
    onResize() {}
  }
  return { FakeTerminal };
});

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

function provideCore(overrides: Record<string, unknown>) {
  provide(ThemeService, { theme: signal('dark') } as unknown as ThemeService);
  return provideBridge({
    terminalWrite: vi.fn().mockResolvedValue(undefined),
    terminalClose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

it('starts a shell where asked, streams it both ways, and marks its exit', async () => {
  let emit: (output: TerminalOutput) => void = () => undefined;
  const bridge = provideCore({
    terminalOpen: vi.fn(
      (_cwd: string | null, _cols: number, _rows: number, onOutput: typeof emit) => {
        emit = onOutput;
        return Promise.resolve({ id: 7, shell: 'pwsh.exe', cwd: '/home/nils/leaf' });
      },
    ),
  });
  const hub = new TerminalHub();

  const key = hub.add('/home/nils/leaf');
  expect(hub.tabs()).toEqual([{ key, title: 'leaf', exited: false }]);
  hub.attach(key, document.createElement('div'));
  expect(bridge.terminalOpen).toHaveBeenCalledWith('/home/nils/leaf', 80, 24, expect.any(Function));

  // Keystrokes reach the shell once it has an id.
  const term = FakeTerminal.made.at(-1)!;
  await vi.waitFor(() => expect(term.typed).not.toBeNull());
  term.typed!('ls\r');
  expect(bridge.terminalWrite).toHaveBeenCalledWith(7, 'ls\r');
  emit({ kind: 'data', data: 'hello' });
  expect(term.written).toContain('hello');

  emit({ kind: 'exit', code: 0 });
  expect(hub.tabs()[0]?.exited).toBe(true);
  expect(term.written.at(-1)).toContain('exited with code 0');
  term.typed!('x');
  expect(bridge.terminalWrite).toHaveBeenCalledTimes(1);

  // An exited shell has nothing left to end; closing just forgets the tab.
  hub.close(key);
  expect(bridge.terminalClose).not.toHaveBeenCalled();
  expect(hub.tabs()).toEqual([]);
  expect(hub.active()).toBeNull();
});

it('ends a live shell when its tab closes', async () => {
  const bridge = provideCore({
    terminalOpen: vi.fn().mockResolvedValue({ id: 3, shell: 'pwsh.exe', cwd: '/' }),
  });
  const hub = new TerminalHub();
  const key = hub.add(null);
  expect(hub.tabs()[0]?.title).toBe('Home');
  hub.attach(key, document.createElement('div'));
  const term = FakeTerminal.made.at(-1)!;
  await vi.waitFor(() => expect(term.typed).not.toBeNull());

  hub.close(key);
  expect(bridge.terminalClose).toHaveBeenCalledWith(3);
});
