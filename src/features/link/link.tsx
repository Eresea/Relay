import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TauriBridge, type LinkProcess, type LinkStatus } from '@/core/tauri';
import { inject } from '@/lib/inject';
import { DestroyRef, signal, useController, useSignals } from '@/lib/signals';

import './link.css';

const PAIRING_POLL_MS = 2000;
const CODE_LENGTH = 10;

/** Shown in two halves, the way it is easiest to read across a room. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * What was typed or pasted, as the PC shows it. Look-alike letters read as the
 * digits they resemble and anything else outside the code's alphabet goes, as
 * in the core's own clean-up. The dash appears only with the sixth character,
 * so backspace can always remove it.
 */
export function formatPairingInput(typed: string): string {
  const code = typed
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, '')
    .slice(0, CODE_LENGTH);
  return code.length > 5 ? formatPairingCode(code) : code;
}

export class LinkState {
  private readonly tauri = inject(TauriBridge);
  readonly destroyRef = new DestroyRef();
  readonly status = signal<LinkStatus | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly code = signal('');
  readonly processes = signal<{ deviceId: string; list: readonly LinkProcess[] } | null>(null);

  constructor() {
    void this.run(() => this.tauri.linkStatus());
    // The core finishes a pairing on its own, so the code on screen is
    // replaced by the new phone as soon as the phone has typed it.
    const poll = setInterval(() => {
      if (this.status()?.pairing) void this.refresh();
    }, PAIRING_POLL_MS);
    this.destroyRef.onDestroy(() => clearInterval(poll));
  }

  private async refresh(): Promise<void> {
    try {
      this.status.set(await this.tauri.linkStatus());
    } catch (error) {
      this.error.set(String(error));
    }
  }

  private async run(action: () => Promise<LinkStatus | null>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const status = await action();
      if (status) this.status.set(status);
    } catch (error) {
      this.error.set(String(error));
    } finally {
      this.busy.set(false);
    }
  }

  startPairing(): Promise<void> {
    return this.run(() => this.tauri.linkPairStart());
  }

  cancelPairing(): Promise<void> {
    return this.run(() => this.tauri.linkPairCancel());
  }

  async pair(): Promise<void> {
    await this.run(() => this.tauri.linkPair(this.code()));
    if (!this.error()) this.code.set('');
  }

  forget(id: string): Promise<void> {
    if (this.processes()?.deviceId === id) this.processes.set(null);
    return this.run(() => this.tauri.linkForget(id));
  }

  listProcesses(deviceId: string): Promise<void> {
    return this.run(async () => {
      this.processes.set({ deviceId, list: await this.tauri.linkProcesses(deviceId) });
      return null;
    });
  }
}

/**
 * The phone link's one surface. The PC shows a code and lists the phones that
 * may ask it for things; the phone types the code and does the asking.
 */
export function Link() {
  useSignals();
  const s = useController(() => new LinkState());
  const status = s.status();
  if (!status) return s.error() ? <p className="link-error">{s.error()}</p> : null;
  const onPhone = status.role === 'phone';
  const shown = s.processes();

  return (
    <div className="link">
      <section className="group">
        <h2 className="u-caption">{onPhone ? 'Your PC' : 'Your phone'}</h2>
        <p className="link-intro">
          {onPhone
            ? 'Open Relay on your PC, choose Settings, then Phone link, and pair. Type the code it shows here.'
            : 'Pair your phone once. It can then ask this PC for its running processes, and nothing else. Your Nexus account carries the messages but cannot read or forge them.'}
        </p>

        {status.devices.length > 0 && (
          <ul className="link-devices">
            {status.devices.map((device) => (
              <li key={device.id}>
                <span className="link-device-name">{device.name}</span>
                {onPhone && (
                  <Button
                    disabled={s.busy()}
                    onClick={() => void s.listProcesses(device.id)}
                    size="sm"
                  >
                    List processes
                  </Button>
                )}
                <Button
                  disabled={s.busy()}
                  onClick={() => void s.forget(device.id)}
                  size="sm"
                  variant="ghost"
                >
                  {onPhone ? 'Forget' : 'Revoke'}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {onPhone ? (
          <form
            className="link-pair"
            onSubmit={(event) => {
              event.preventDefault();
              void s.pair();
            }}
          >
            <Input
              aria-label="Pairing code"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              className="link-code-input"
              enterKeyHint="go"
              inputMode="text"
              onValueChange={(value) => s.code.set(formatPairingInput(value))}
              placeholder="XXXXX-XXXXX"
              spellCheck={false}
              value={s.code()}
            />
            <Button
              disabled={s.busy() || s.code().replace('-', '').length < CODE_LENGTH}
              type="submit"
            >
              {s.busy() ? 'Pairing…' : 'Pair'}
            </Button>
          </form>
        ) : status.pairing ? (
          <div className="link-pair">
            <output aria-label="Pairing code" className="link-code">
              {formatPairingCode(status.pairing.code)}
            </output>
            <Button disabled={s.busy()} onClick={() => void s.cancelPairing()} variant="ghost">
              Cancel
            </Button>
          </div>
        ) : (
          <Button disabled={s.busy()} onClick={() => void s.startPairing()}>
            Pair a phone
          </Button>
        )}

        {s.error() && (
          <p className="link-error" role="alert">
            {s.error()}
          </p>
        )}
      </section>

      {shown && (
        <section className="group">
          <h2 className="u-caption">Running processes ({shown.list.length})</h2>
          <ul className="link-processes">
            {shown.list.map((process) => (
              <li key={process.pid}>
                <span>{process.name}</span>
                <span className="link-pid">{process.pid}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
