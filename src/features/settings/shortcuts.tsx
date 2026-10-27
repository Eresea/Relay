import type { KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { TauriBridge, type ShortcutAction, type ShortcutInfo } from '@/core/tauri';
import { inject } from '@/lib/inject';
import { signal, useController, useSignals } from '@/lib/signals';
import { cn } from '@/lib/utils';
import { Kbd } from '@/shared/kbd';

const MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS']);

/**
 * The combination a key press makes, in the core's notation: modifiers in a
 * fixed order, then the key by its physical code (`KeyK`, `Digit1`). Null
 * while only modifiers are down.
 */
export function acceleratorOf(
  event: Pick<
    globalThis.KeyboardEvent,
    'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'
  >,
): string | null {
  if (MODIFIERS.has(event.key) || !event.code) return null;
  return [
    event.ctrlKey && 'Ctrl',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    event.metaKey && 'Super',
    event.code,
  ]
    .filter(Boolean)
    .join('+');
}

/** `Ctrl+Shift+KeyK` as keycaps: Ctrl, Shift, K. */
export function keycaps(accelerator: string): string[] {
  return accelerator
    .split('+')
    .map((key) => key.replace(/^Key(?=[A-Z]$)/, '').replace(/^Digit(?=\d$)/, ''))
    .map((key) => (key === 'Super' ? 'Win' : key));
}

const message = (cause: unknown, fallback: string) =>
  typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : fallback;

class ShortcutsState {
  private readonly tauri = inject(TauriBridge);
  readonly list = signal<readonly ShortcutInfo[]>([]);
  readonly recording = signal<ShortcutAction | null>(null);
  readonly errors = signal<Partial<Record<ShortcutAction, string>>>({});

  start(): void {
    void this.tauri.shortcutsList().then((list) => this.list.set(list));
  }

  private put(info: ShortcutInfo | null): void {
    if (info) this.list.update((list) => list.map((s) => (s.action === info.action ? info : s)));
  }

  private fail(action: ShortcutAction, cause: unknown): void {
    this.errors.update((errors) => ({
      ...errors,
      [action]: message(cause, 'Could not change it.'),
    }));
  }

  /** While recording, the next full combination becomes the shortcut; Escape cancels. */
  async record(action: ShortcutAction, event: KeyboardEvent): Promise<void> {
    event.preventDefault();
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      this.recording.set(null);
      return;
    }
    const accelerator = acceleratorOf(event);
    if (!accelerator) return;
    this.recording.set(null);
    this.errors.update((errors) => ({ ...errors, [action]: undefined }));
    try {
      this.put(await this.tauri.shortcutsSet(action, accelerator));
    } catch (cause) {
      this.fail(action, cause);
    }
  }

  async reset(action: ShortcutAction): Promise<void> {
    this.errors.update((errors) => ({ ...errors, [action]: undefined }));
    try {
      this.put(await this.tauri.shortcutsReset(action));
    } catch (cause) {
      this.fail(action, cause);
    }
  }
}

/** Settings' Shortcuts section: each global shortcut, whether it works, and how to change it. */
export function Shortcuts() {
  useSignals();
  const s = useController(() => new ShortcutsState());

  return (
    <section className="group" aria-labelledby="shortcuts-title">
      <h2 className="u-caption" id="shortcuts-title">
        Shortcuts
      </h2>
      {s.list().length === 0 && <p className="hint">Global shortcuts need the Relay app.</p>}
      {s.list().map((shortcut) => {
        const recording = s.recording() === shortcut.action;
        const problem =
          s.errors()[shortcut.action] ?? (shortcut.status === 'active' ? null : shortcut.message);
        return (
          <div className="row" key={shortcut.action}>
            <div>
              <p className="label">{shortcut.label}</p>
              <p
                className={cn('hint', problem && 'shortcut-problem')}
                role={problem ? 'alert' : undefined}
              >
                {recording
                  ? 'Press the new combination, or Escape to cancel.'
                  : (problem ?? 'Works everywhere, even when Relay is in the background.')}
              </p>
            </div>
            <div className="shortcut-controls">
              <button
                type="button"
                className={cn(
                  'shortcut-keys',
                  recording && 'recording',
                  shortcut.status !== 'active' && 'broken',
                )}
                aria-label={`${shortcut.label}: ${shortcut.accelerator}. Change`}
                onClick={() => s.recording.set(recording ? null : shortcut.action)}
                onKeyDown={(event) => {
                  if (recording) void s.record(shortcut.action, event);
                }}
                onBlur={() => {
                  if (recording) s.recording.set(null);
                }}
              >
                {recording ? 'Recording…' : <Kbd keys={keycaps(shortcut.accelerator)} />}
              </button>
              {shortcut.accelerator !== shortcut.default && (
                <Button size="sm" variant="link" onClick={() => void s.reset(shortcut.action)}>
                  Reset to {shortcut.default}
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
