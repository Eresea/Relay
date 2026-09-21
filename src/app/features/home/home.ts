import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';

import { TauriBridge, type ProjectContext } from '@core/tauri';
import { ThemeService } from '@core/theme';
import { Settings } from '@features/settings/settings';
import { Vault } from '@features/vault/vault';
import { Icon } from '@shared/icon';
import { Kbd } from '@shared/kbd';
import { NotificationPopover } from '@shared/notification-popover';

const RAIL_EXPANDED_SETTING_KEY = 'rail.expanded';

/**
 * The main window. `decorations: false` in tauri.conf.json means the OS draws
 * no title bar of its own, so everything here — including the
 * minimize/maximize/close buttons and the left rail navigation — is drawn by
 * the app itself and must behave like a native shell: a titlebar that never
 * scrolls out of view, and window buttons flush against the window's own top
 * and right edges rather than floating inside a padded box.
 */
@Component({
  selector: 'rl-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Kbd, NotificationPopover, Settings, Vault],
  template: `
    <header class="titlebar u-chrome" data-tauri-drag-region>
      <div class="titlebar-start">
        <button
          type="button"
          class="home-btn"
          [class.active]="view() === 'home'"
          (click)="view.set('home')"
          aria-label="Home"
        >
          <rl-icon name="house" [size]="16" />
        </button>
        <span class="wordmark">Relay</span>
        <rl-notification-popover />
      </div>
      <div class="window-controls">
        <button type="button" class="window-btn" (click)="theme.toggle()" aria-label="Toggle theme">
          <rl-icon [name]="theme.theme() === 'dark' ? 'sun' : 'moon'" [size]="14" />
        </button>
        <button type="button" class="window-btn" (click)="minimize()" aria-label="Minimize">
          <rl-icon name="minus" [size]="14" />
        </button>
        <button
          type="button"
          class="window-btn"
          (click)="toggleMaximize()"
          [attr.aria-label]="maximized() ? 'Restore' : 'Maximize'"
        >
          <rl-icon [name]="maximized() ? 'copy' : 'square'" [size]="14" />
        </button>
        <button type="button" class="window-btn close" (click)="close()" aria-label="Close">
          <rl-icon name="x" [size]="14" />
        </button>
      </div>
    </header>

    <div class="body">
      <nav class="rail u-chrome" [class.expanded]="railExpanded()">
        <div class="rail-top">
          <button
            type="button"
            class="rail-toggle"
            (click)="toggleRail()"
            [attr.aria-label]="railExpanded() ? 'Collapse sidebar' : 'Expand sidebar'"
          >
            <rl-icon name="panel-left" [size]="16" />
          </button>
        </div>

        <div class="rail-bottom">
          <button
            type="button"
            class="rail-item"
            [class.active]="view() === 'settings'"
            (click)="openSettings()"
            aria-label="Settings"
          >
            <span class="rail-icon"><rl-icon name="settings" [size]="16" /></span>
            <span class="rail-label">Settings</span>
          </button>
        </div>
      </nav>

      <main class="content">
        @if (view() === 'settings') {
          <rl-settings [initialTab]="settingsTab()" />
        } @else if (view() === 'vault') {
          <rl-vault />
        } @else {
          <div class="cold-start-wrap">
            <div class="cold-start">
              <p class="u-title">A quiet place to work</p>
              <p class="body">Everything else is behind <rl-kbd [keys]="paletteKeys" />.</p>

              <section class="context-card" aria-labelledby="project-context-title">
                <div class="context-header">
                  <div>
                    <p id="project-context-title" class="u-caption">Current project</p>
                    @if (project(); as current) {
                      <p class="project-name">{{ current.name }}</p>
                      <p class="project-path">{{ current.path }}</p>
                    } @else {
                      <p class="hint">No project set</p>
                    }
                  </div>
                  @if (project()) {
                    <div class="context-actions">
                      <button type="button" class="link" (click)="openProject()">Open</button>
                      <button type="button" class="link" (click)="clearProject()">Forget</button>
                    </div>
                  }
                </div>

                <label class="field-label" for="project-path">Project folder</label>
                <input
                  id="project-path"
                  class="field"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="C:\\Work\\project"
                  [value]="projectPath()"
                  (input)="projectPath.set($any($event.target).value)"
                />
                @if (projectError()) {
                  <p class="error">{{ projectError() }}</p>
                }
                <button type="button" class="primary" (click)="saveProject()">
                  {{ project() ? 'Update project' : 'Set current project' }}
                </button>
              </section>
            </div>
          </div>
        }
      </main>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      block-size: 100%;
      overflow: hidden;
    }

    /* Fixed, edge-to-edge titlebar: never scrolls, and its own top/right
     * edges are the window's top/right edges so the caption buttons sit
     * exactly where a native titlebar would put them. */
    .titlebar {
      display: flex;
      align-items: stretch;
      justify-content: space-between;
      flex: none;
      block-size: var(--titlebar-height);
      padding-inline-start: var(--space-4);
      border-block-end: 1px solid var(--border-subtle);
      background: var(--bg-sunken);
    }

    .titlebar-start {
      display: flex;
      align-items: center;
      gap: var(--space-4);
    }

    .home-btn {
      display: grid;
      place-items: center;
      inline-size: var(--control-sm);
      block-size: var(--control-sm);
      color: var(--text-subtle);
      border-radius: var(--radius-sm);
      transition:
        background-color var(--dur-hover) var(--ease-standard),
        color var(--dur-hover) var(--ease-standard);
    }

    .home-btn:hover {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .home-btn.active {
      color: var(--text-strong);
    }

    .wordmark {
      font-size: var(--text-13);
      font-weight: var(--weight-semibold);
      letter-spacing: -0.045em;
      color: var(--text-body);
    }

    .window-controls {
      display: flex;
      align-items: stretch;
    }

    .window-btn {
      display: grid;
      place-items: center;
      inline-size: 46px;
      block-size: 100%;
      color: var(--text-subtle);
      border-radius: 0;
      transition:
        background-color var(--dur-hover) var(--ease-standard),
        color var(--dur-hover) var(--ease-standard);
    }

    .window-btn:hover {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .window-btn.close:hover {
      color: var(--danger-ink);
      background: var(--danger);
    }

    .body {
      display: flex;
      flex: 1;
      min-block-size: 0;
    }

    .rail {
      display: flex;
      flex-direction: column;
      flex: none;
      inline-size: var(--sidebar-width-collapsed);
      padding: var(--space-3);
      border-inline-end: 1px solid var(--border-subtle);
      background: var(--bg-sunken);
      transition: inline-size var(--dur-panel) var(--ease-standard);
      overflow: hidden;
    }

    .rail.expanded {
      inline-size: var(--sidebar-width);
    }

    /* Future page buttons stack here, growing downward from the top. */
    .rail-top {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      flex: 1;
      min-block-size: 0;
    }

    /* Settings stays pinned to the rail's bottom edge, apart from the rest. */
    .rail-bottom {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      flex: none;
    }

    /* A 1:1 icon button — the toggle's own shape at every rail width, and
     * a nav item's shape once the rail is narrow enough that its label is
     * gone. Fixed square dimensions rather than a stretched-to-fit row, so
     * it never reads as a wide bar with a stray icon in it. */
    .rail-toggle {
      display: grid;
      place-items: center;
      flex: none;
      inline-size: var(--control-sm);
      block-size: var(--control-sm);
      color: var(--text-subtle);
      border-radius: var(--radius-sm);
      transition:
        background-color var(--dur-hover) var(--ease-standard),
        color var(--dur-hover) var(--ease-standard);
    }

    .rail-toggle:hover {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .rail-item {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      inline-size: 100%;
      block-size: var(--control-sm);
      padding-inline: var(--space-2);
      color: var(--text-subtle);
      border-radius: var(--radius-sm);
      transition:
        background-color var(--dur-hover) var(--ease-standard),
        color var(--dur-hover) var(--ease-standard);
    }

    .rail-item:hover {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .rail-item.active {
      color: var(--text-strong);
      background: var(--tint-hover);
    }

    .rail-icon {
      display: grid;
      place-items: center;
      flex: none;
      inline-size: var(--control-sm);
      block-size: var(--control-sm);
    }

    .rail-label {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
    }

    /* Collapsed: only the icon shows, as a square the same size as the
     * toggle above it — the label is removed from layout rather than just
     * clipped, so it can't skew the icon off-centre or hold onto its row's
     * width. */
    .rail:not(.expanded) .rail-item {
      inline-size: var(--control-sm);
      padding-inline: 0;
      gap: 0;
    }

    .rail:not(.expanded) .rail-label {
      display: none;
    }

    .content {
      flex: 1;
      min-inline-size: 0;
      overflow-y: auto;
    }

    .cold-start-wrap {
      display: grid;
      place-items: center;
      min-block-size: 100%;
      padding: var(--space-8);
    }

    .cold-start {
      max-inline-size: var(--content-max);
      text-align: center;
    }

    .cold-start .body {
      display: flex;
      gap: var(--space-3);
      align-items: center;
      justify-content: center;
      margin: var(--space-4) 0 0;
      font-size: var(--text-13);
      color: var(--text-muted);
    }

    .context-card {
      margin-block-start: var(--space-8);
      padding: var(--space-5);
      text-align: start;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: var(--bg-app);
    }

    .context-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-5);
    }

    .project-name,
    .project-path,
    .field-label {
      margin: 0;
    }

    .project-name {
      margin-block-start: var(--space-2);
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
      color: var(--text-body);
    }

    .project-path {
      margin-block-start: var(--space-1);
      overflow: hidden;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: var(--text-12);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .field-label {
      display: block;
      margin-block-start: var(--space-5);
      font-size: var(--text-12);
      color: var(--text-muted);
    }

    .field {
      inline-size: 100%;
      margin-block-start: var(--space-2);
      padding: var(--space-3) var(--space-4);
      color: var(--text-body);
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
    }

    .field:focus {
      background: var(--bg-app);
      border-color: var(--border-focus);
      box-shadow: var(--focus-ring);
    }

    .context-actions {
      display: flex;
      flex: none;
      gap: var(--space-2);
    }

    .link,
    .primary {
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-sm);
    }

    .link {
      color: var(--accent);
      font-size: var(--text-12);
    }

    .link:hover {
      background: var(--tint-hover);
    }

    .primary {
      margin-block-start: var(--space-4);
      color: var(--primary-ink);
      background: var(--primary);
      font-size: var(--text-12);
      font-weight: var(--weight-medium);
    }

    .primary:hover {
      background: var(--primary-hover);
    }

    .hint,
    .error {
      margin: var(--space-2) 0 0;
      font-size: var(--text-12);
    }

    .hint {
      color: var(--text-muted);
    }

    .error {
      color: var(--danger-ink);
    }
  `,
})
export class Home {
  protected readonly theme = inject(ThemeService);
  protected readonly paletteKeys = ['Ctrl', 'Space'] as const;
  protected readonly view = signal<'home' | 'settings' | 'vault'>('home');
  /** Starts collapsed — the safe default while the persisted value (below) is
   * still loading — then reconciles with whatever the user last left it as. */
  protected readonly railExpanded = signal(false);
  protected readonly settingsTab = signal<'general' | 'github'>('general');
  protected readonly project = signal<ProjectContext | null>(null);
  protected readonly projectPath = signal('');
  protected readonly projectError = signal('');

  private readonly tauri = inject(TauriBridge);
  protected readonly maximized = signal(false);

  constructor() {
    void this.tauri
      .getSetting<boolean>(RAIL_EXPANDED_SETTING_KEY, this.railExpanded())
      .then((stored) => this.railExpanded.set(stored));

    void this.tauri.isWindowMaximized().then((value) => this.maximized.set(value));

    void this.tauri.getProjectContext().then((project) => {
      this.project.set(project);
      this.projectPath.set(project?.path ?? '');
    });

    const destroyRef = inject(DestroyRef);
    void this.tauri
      .onWindowResized(
        () => void this.tauri.isWindowMaximized().then((value) => this.maximized.set(value)),
      )
      .then((unlisten) => destroyRef.onDestroy(unlisten));

    // The palette that dispatched "Open settings" and this window are
    // separate webviews with no shared JS state, so the core tells us to
    // switch views over the event channel rather than us reading any local
    // signal it could have set directly.
    void this.tauri
      .onEvent((event) => {
        if (event.type === 'openSettingsRequested') {
          this.view.set('settings');
          this.settingsTab.set('general');
        }
        if (event.type === 'openVaultRequested') this.view.set('vault');
        if (event.type === 'openGithubRequested') {
          this.view.set('settings');
          this.settingsTab.set('github');
        }
      })
      .then((unlisten) => destroyRef.onDestroy(unlisten));
  }

  protected openSettings(): void {
    this.view.set('settings');
    this.settingsTab.set('general');
  }

  protected toggleRail(): void {
    const expanded = !this.railExpanded();
    this.railExpanded.set(expanded);
    void this.tauri.setSetting(RAIL_EXPANDED_SETTING_KEY, expanded);
  }

  protected async saveProject(): Promise<void> {
    const path = this.projectPath().trim();
    if (!path) {
      this.projectError.set('Enter a project folder path.');
      return;
    }

    const normalized = path.replace(/[\\/]+$/, '');
    const name = normalized.split(/[\\/]/).pop() || normalized;
    const project = { name, path } satisfies ProjectContext;
    try {
      await this.tauri.setProjectContext(project);
      this.project.set(project);
      this.projectError.set('');
    } catch {
      this.projectError.set('Could not save the project.');
    }
  }

  protected async clearProject(): Promise<void> {
    try {
      await this.tauri.setProjectContext(null);
      this.project.set(null);
      this.projectPath.set('');
      this.projectError.set('');
    } catch {
      this.projectError.set('Could not forget the project.');
    }
  }

  protected openProject(): void {
    const project = this.project();
    if (project) void this.tauri.openPath(project.path);
  }

  protected minimize(): void {
    void this.tauri.minimizeWindow();
  }

  protected toggleMaximize(): void {
    void this.tauri.toggleMaximizeWindow();
  }

  protected close(): void {
    void this.tauri.closeWindow();
  }
}
