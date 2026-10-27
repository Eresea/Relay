import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { CommandRegistry } from '@/core/command-registry';
import { moduleHueVar } from '@/core/entity-hue';
import { ModuleRegistry, PERMISSIONS, type ModuleManifest, type Permission } from '@/core/modules';
import { inject } from '@/lib/inject';
import { useLocalSignal, useSignals } from '@/lib/signals';
import { cn, vars } from '@/lib/utils';
import { TauriBridge } from '@/core/tauri';
import { PinWebApp } from '@/features/webapps/pin-web-app';
import { Icon } from '@/shared/icon';

import './modules.css';

const CONTRACT = [
  ['Commands', 'appear in the Omnibar'],
  ['Items', 'land in Today'],
  ['Surfaces', 'open as tabs'],
  ['Signals', 'drive the pill and the stack'],
] as const;

const tone = (m: ModuleManifest) => vars({ '--entity-hue': moduleHueVar(m.hue) });

function gives(m: ModuleManifest): string[] {
  const n = m.commands.length;
  return [
    ...(n > 0 ? [`${n} command${n === 1 ? '' : 's'}`] : []),
    ...(m.items ? ['items'] : []),
    ...(m.surface ? ['surface'] : []),
    ...(m.signals ? ['signals'] : []),
  ];
}

/**
 * Every capability Relay has, as a module: what it gives, what it needs, and
 * whether it is on. Built-in modules are part of Relay, so their needs are
 * declared here rather than asked for.
 */
export default function Modules({ onOpen }: { onOpen: (id: string) => void }) {
  useSignals();
  const registry = inject(ModuleRegistry);
  const commands = inject(CommandRegistry);
  const tauri = inject(TauriBridge);
  const query = useLocalSignal('');
  const selectedId = useLocalSignal('today');

  const q = query().trim().toLowerCase();
  const shown = registry
    .all()
    .filter((m) => `${m.name} ${m.summary} ${m.description}`.toLowerCase().includes(q));
  const on = registry.enabled().length;
  const selected = registry.get(selectedId()) ?? registry.all()[0];
  if (!selected) return <p className="page-loading" aria-busy="true" />;

  const toggle = (m: ModuleManifest) =>
    m.core ? (
      <span className="always">Always on</span>
    ) : (
      <Switch
        aria-label={`${m.name} on`}
        checked={registry.isEnabled(m.id)}
        onCheckedChange={(checked) =>
          void registry.setEnabled(m.id, checked).catch(() => undefined)
        }
      />
    );

  return (
    <section className="modules" aria-labelledby="modules-title">
      <header className="panehead">
        <h1 id="modules-title">Modules</h1>
        <span className="count">
          {on} on · {registry.all().length - on} off
        </span>
        <label className="search">
          <Icon name="search" size={14} />
          <input
            value={query()}
            onChange={(event) => query.set(event.target.value)}
            placeholder="Search modules"
            aria-label="Search modules"
          />
        </label>
      </header>

      <div className="modules-body">
        <div className="modules-main">
          <dl className="contract">
            {CONTRACT.map(([term, means]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{means}</dd>
              </div>
            ))}
          </dl>
          <p className="intro">
            A module declares what it gives and what it needs, and Relay draws the rest. Turning one
            off removes its tab, its Today items and its commands.
          </p>

          <div className="grid">
            {shown.map((m) => {
              const enabled = registry.isEnabled(m.id);
              return (
                <article
                  key={m.id}
                  className={cn('card', m.id === selected.id && 'on', !enabled && 'off')}
                  aria-label={m.name}
                >
                  <div className="card-head">
                    <button
                      type="button"
                      className="card-open"
                      aria-pressed={m.id === selected.id}
                      onClick={() => selectedId.set(m.id)}
                    >
                      <span className="u-entity-tile tile" style={tone(m)}>
                        <Icon name={m.icon} size={16} />
                      </span>
                      <span className="card-name">
                        <span className="name">{m.name}</span>
                        <span className="summary">{m.summary}</span>
                      </span>
                    </button>
                    {toggle(m)}
                  </div>
                  <div className="gives">
                    {gives(m).map((g) => (
                      <span key={g} className="chip">
                        {g}
                      </span>
                    ))}
                  </div>
                  <p className="needs">
                    {enabled ? (
                      <>
                        <Icon name="shield" size={14} />
                        {m.needs.length > 0
                          ? m.needs.map((n) => n.scope).join(', ')
                          : 'Needs nothing'}
                      </>
                    ) : (
                      'Off · hidden everywhere'
                    )}
                  </p>
                </article>
              );
            })}
            {shown.length === 0 && <p className="intro">No module matches “{query()}”.</p>}
          </div>
          <PinWebApp onPinned={(id) => selectedId.set(id)} />
        </div>

        <aside className="module-detail" aria-label={`${selected.name} details`}>
          <section className="sect">
            <div className="detail-head">
              <span className="u-entity-tile tile-xl" style={tone(selected)}>
                <Icon name={selected.icon} size={20} />
              </span>
              <span className="card-name">
                <span className="name">{selected.name}</span>
                <span className="summary">
                  {selected.summary} · {selected.kind}
                </span>
              </span>
              {toggle(selected)}
            </div>
            <p className="description">{selected.description}</p>
          </section>

          <section className="sect">
            <h2 className="u-caption">Needs</h2>
            {(Object.keys(PERMISSIONS) as Permission[]).map((permission) => {
              const need = selected.needs.find((n) => n.permission === permission);
              return (
                <p key={permission} className={cn('perm', !need && 'unasked')}>
                  <Icon name={need ? 'check' : 'x'} size={14} />
                  <span className="perm-name">{PERMISSIONS[permission]}</span>
                  <span className="perm-scope">{need?.scope ?? 'not asked'}</span>
                </p>
              );
            })}
          </section>

          <section className="sect">
            <h2 className="u-caption">Gives</h2>
            {selected.commands.map((id) => (
              <p key={id} className="perm">
                <Icon name="command" size={14} />
                <span className="perm-name">{commands.byId(id)?.title ?? id}</span>
              </p>
            ))}
            {selected.surface && (
              <p className="perm">
                <Icon name="panel-right" size={14} />
                <span className="perm-name">Surface · {selected.surface.label} tab</span>
              </p>
            )}
            {selected.items && (
              <p className="perm">
                <Icon name="house" size={14} />
                <span className="perm-name">Items in Today</span>
              </p>
            )}
            {selected.signals && (
              <p className="perm">
                <Icon name="activity" size={14} />
                <span className="perm-name">Signals · the attention pill and stack</span>
              </p>
            )}
            {gives(selected).length === 0 && (
              <p className="intro">Nothing beyond its own screen.</p>
            )}
          </section>

          {selected.surface && selected.id !== 'modules' && (
            <section className="sect actions">
              <Button
                size="sm"
                variant="outline"
                disabled={!registry.isEnabled(selected.id)}
                onClick={() => onOpen(selected.id)}
              >
                Open {selected.surface.label}
              </Button>
              {selected.source === 'pinned' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void tauri
                      .webAppsUnpin(selected.id.slice('web-'.length))
                      .then(() => registry.load())
                      .then(() => selectedId.set('today'))
                  }
                >
                  Unpin and forget its sign-in
                </Button>
              )}
            </section>
          )}
        </aside>
      </div>
    </section>
  );
}
