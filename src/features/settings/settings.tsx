import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { TauriBridge } from '@/core/tauri';
import { ThemeService } from '@/core/theme';
import { Github } from '@/features/github/github';
import { Gmail } from '@/features/gmail/gmail';
import { LinearSettings } from '@/features/linear/linear-settings';
import { inject } from '@/lib/inject';
import { signal, useController, useSignals } from '@/lib/signals';
import { cn } from '@/lib/utils';

import './settings.css';

const HUD_TOP_OFFSET_KEY = 'hud.topOffset';
const DEFAULT_HUD_TOP_OFFSET = 0;
const MAX_HUD_TOP_OFFSET = 2000;

export type SettingsTab = 'general' | 'github' | 'gmail' | 'linear';

function clampHudTopOffset(offset: number): number {
  return Number.isFinite(offset)
    ? Math.min(MAX_HUD_TOP_OFFSET, Math.max(0, Math.round(offset)))
    : DEFAULT_HUD_TOP_OFFSET;
}

class SettingsState {
  private readonly tauri = inject(TauriBridge);
  readonly theme = inject(ThemeService);

  readonly tab = signal<SettingsTab>('general');
  readonly launchAtLogin = signal(false);
  readonly launchAtLoginPending = signal(true);
  readonly hudTopOffset = signal(DEFAULT_HUD_TOP_OFFSET);

  constructor() {
    void this.tauri.isAutostartEnabled().then((enabled) => {
      this.launchAtLogin.set(enabled);
      this.launchAtLoginPending.set(false);
    });
    void this.tauri
      .getSetting<number>(HUD_TOP_OFFSET_KEY, DEFAULT_HUD_TOP_OFFSET)
      .then((offset) => this.hudTopOffset.set(clampHudTopOffset(offset)));
  }

  saveHudTopOffset(value: string): void {
    const offset = clampHudTopOffset(Number.parseInt(value, 10));
    this.hudTopOffset.set(offset);
    void this.tauri.setSetting(HUD_TOP_OFFSET_KEY, offset);
  }

  setLaunchAtLogin(next: boolean): void {
    const previous = this.launchAtLogin();
    this.launchAtLogin.set(next);
    this.launchAtLoginPending.set(true);
    void this.tauri
      .setAutostart(next)
      .catch(() => this.launchAtLogin.set(previous))
      .finally(() => this.launchAtLoginPending.set(false));
  }
}

const TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'github', label: 'GitHub' },
  { id: 'gmail', label: 'Gmail' },
  { id: 'linear', label: 'Linear' },
];

/**
 * Relay's one settings surface. Everything here persists through the core's
 * settings store or, for launch-at-login, the OS's autostart registration.
 *
 * Tabs are hidden, not unmounted: a GitHub Device Flow can take minutes to
 * approve, and unmounting GitHub mid-wait would drop its event listener and
 * silently lose the switch to "connected".
 */
export default function Settings({ initialTab = 'general' }: { initialTab?: SettingsTab }) {
  useSignals();
  const s = useController(() => new SettingsState());
  useEffect(() => s.tab.set(initialTab), [s, initialTab]);
  const tab = s.tab();

  return (
    <div className="settings">
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={cn('tab', tab === t.id && 'active')}
            onClick={() => s.tab.set(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div hidden={tab !== 'general'}>
        <section className="group">
          <h2 className="u-caption">Appearance</h2>
          <div className="row">
            <div>
              <p className="label">Theme</p>
              <p className="hint">{s.theme.theme() === 'dark' ? 'Dark' : 'Light'} is active.</p>
            </div>
            <Button size="sm" variant="link" onClick={() => s.theme.toggle()}>
              Switch to {s.theme.theme() === 'dark' ? 'light' : 'dark'}
            </Button>
          </div>
          <div className="row">
            <div>
              <p className="label">Activity pill offset</p>
              <p className="hint">Extra space above the activity pill, in pixels.</p>
            </div>
            <span className="number-input">
              <Input
                type="number"
                min={0}
                max={2000}
                step={1}
                value={s.hudTopOffset().toString()}
                aria-label="Activity pill offset in pixels"
                onValueChange={(value) => s.saveHudTopOffset(value)}
              />
            </span>
          </div>
        </section>

        <section className="group">
          <h2 className="u-caption">Startup</h2>
          <div className="row">
            <div>
              <p className="label">Launch at login</p>
              <p className="hint">Starts hidden in the tray, the same as any other launch.</p>
            </div>
            <Switch
              aria-label="Launch at login"
              checked={s.launchAtLogin()}
              disabled={s.launchAtLoginPending()}
              onCheckedChange={(checked) => s.setLaunchAtLogin(checked)}
            />
          </div>
        </section>
      </div>

      <div hidden={tab !== 'github'}>
        <Github />
      </div>
      <div hidden={tab !== 'gmail'}>
        <Gmail />
      </div>
      <div hidden={tab !== 'linear'}>
        <LinearSettings />
      </div>
    </div>
  );
}
