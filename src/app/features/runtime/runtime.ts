import { ChangeDetectionStrategy, Component, inject, OnDestroy, signal } from '@angular/core';

import {
  TauriBridge,
  type LeafHealthObservation,
  type RuntimeGrafanaCheck,
  type RuntimeGrafanaDashboard,
  type RuntimeGrafanaSettings,
  type RuntimeGrafanaPanelInventory,
  type NexusReadinessObservation,
} from '@core/tauri';
import { Icon } from '@shared/icon';

const RUNTIME_STATUS_POLL_INTERVAL_MS = 30_000;
const RUNTIME_STATUS_STALE_AFTER_MS = 90_000;

@Component({
  selector: 'rl-runtime',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <section class="runtime" aria-labelledby="runtime-title">
      <header class="page-header">
        <div>
          <p class="u-caption">Operations</p>
          <h1 id="runtime-title">Runtime</h1>
          <p class="page-description">Leaf production status and a direct Nexus readiness check.</p>
        </div>
        <div class="page-actions">
          <button
            type="button"
            class="secondary-button"
            [disabled]="
              leafRefreshing() ||
              nexusRefreshing() ||
              (leafHealthState() === 'unavailable' && nexusHealthState() === 'unavailable')
            "
            (click)="refreshRuntimeStatus()"
          >
            {{ leafRefreshing() || nexusRefreshing() ? 'Refreshing…' : 'Refresh status' }}
          </button>
          <button
            type="button"
            class="open-button"
            [disabled]="loading() || (!dashboardUrl().trim() && !grafanaUrl().trim())"
            (click)="openGrafana()"
          >
            Open Grafana
          </button>
        </div>
      </header>

      <section class="overview" aria-labelledby="overview-title">
        <div class="overview-heading">
          <div>
            <h2 id="overview-title">Leaf · Production</h2>
            <p>Direct production probes · response headers measured from Relay</p>
          </div>
          <span class="overview-updated">{{ probeSummary() }}</span>
        </div>
        <div class="status-grid-scroll">
          <table class="status-grid">
            <caption class="u-sr-only">
              Leaf production runtime status
            </caption>
            <thead>
              <tr>
                <th scope="col">Signal</th>
                <th scope="col">Production</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <span>Leaf API</span>
                  <small>Public HTTP liveness</small>
                </th>
                <td>
                  <div class="signal-cell">
                    <span class="u-sr-only">Production status:</span>
                    <span
                      class="state"
                      [class.operational]="leafHealthState() === 'reachable'"
                      [class.stale]="leafHealthState() === 'stale'"
                      [style.color]="leafHealthState() === 'not-ready' ? 'var(--danger)' : null"
                    >
                      {{ leafHealthLabel() }} · {{ probeEvidence(leafHealth()) }}
                    </span>
                    <p role="status">{{ leafHealthDetail() }}</p>
                    <button
                      type="button"
                      class="secondary-button"
                      [disabled]="leafHealthState() === 'unavailable'"
                      aria-label="Open Leaf API liveness endpoint"
                      (click)="openHealthSource('https://leaf.eresea.net/api/version/health')"
                    >
                      View source
                    </button>
                  </div>
                </td>
              </tr>
              <tr>
                <th scope="row">
                  <span>Nexus API</span>
                  <small>Public API and database readiness</small>
                </th>
                <td>
                  <div class="signal-cell">
                    <span class="u-sr-only">Production status:</span>
                    <span
                      class="state"
                      [class.operational]="nexusHealthState() === 'ready'"
                      [class.stale]="nexusHealthState() === 'stale'"
                      [style.color]="nexusHealthState() === 'not-ready' ? 'var(--danger)' : null"
                    >
                      {{ nexusHealthLabel() }} · {{ probeEvidence(nexusHealth()) }}
                    </span>
                    <p role="status">{{ nexusHealthDetail() }}</p>
                    <button
                      type="button"
                      class="secondary-button"
                      [disabled]="nexusHealthState() === 'unavailable'"
                      aria-label="Open Nexus readiness endpoint"
                      (click)="openHealthSource('https://nexus.eresea.net/readyz')"
                    >
                      View source
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="setup-notice" role="status" aria-labelledby="setup-title">
        <span class="notice-icon"><rl-icon name="info" [size]="16" /></span>
        <div>
          <h2 id="setup-title">Runtime signal coverage is partial</h2>
          <p>
            Leaf HTTP liveness is checked directly. It does not validate application dependencies;
            Nexus readiness is checked from this Relay client and does not prove Leaf can reach it.
            Grafana metrics remain unmapped until the datasource is confirmed.
          </p>
        </div>
      </section>

      <section class="config-card" aria-labelledby="config-title">
        <header class="config-header">
          <div>
            <h2 id="config-title">Grafana connection</h2>
            <p>Connection details are optional until the Leaf Grafana setup is confirmed.</p>
          </div>
          @if (tokenConfigured()) {
            <span class="token-status">Token stored for this Grafana URL</span>
          } @else if (tokenStatus() === 'loading') {
            <span class="token-status">Checking credential store</span>
          } @else if (tokenStatus() === 'unavailable') {
            <span class="token-status">OS credential store unavailable</span>
          } @else if (tokenStatus() === 'needs-url') {
            <span class="token-status">Set Grafana URL to scope a token</span>
          } @else {
            <span class="token-status">No token stored for this URL</span>
          }
        </header>

        @if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        } @else if (notice()) {
          <p class="notice" role="status">{{ notice() }}</p>
        }

        <div class="fields">
          <label class="field">
            <span>Grafana URL</span>
            <input
              type="url"
              autocomplete="url"
              placeholder="https://grafana.example.net"
              [value]="grafanaUrl()"
              [disabled]="loading() || saving() || checking()"
              (input)="setGrafanaUrl($event)"
            />
          </label>
          <label class="field">
            <span>Dashboard URL</span>
            <input
              type="url"
              autocomplete="url"
              placeholder="Leave blank until known"
              [value]="dashboardUrl()"
              [disabled]="loading() || saving() || checking()"
              (input)="setDashboardUrl($event)"
            />
          </label>
          <div class="field token-field">
            <label for="grafana-token">Grafana API token</label>
            <div class="token-input-row">
              <input
                id="grafana-token"
                type="password"
                autocomplete="new-password"
                placeholder="Leave blank until configured"
                [value]="tokenInput()"
                [disabled]="loading() || saving() || checking()"
                (input)="setTokenInput($event)"
              />
              <button
                type="button"
                class="secondary-button"
                [disabled]="
                  saving() ||
                  checking() ||
                  tokenStatus() === 'loading' ||
                  !tokenInput().trim() ||
                  !grafanaUrl().trim()
                "
                (click)="saveToken()"
              >
                Store token
              </button>
              @if (tokenConfigured()) {
                <button
                  type="button"
                  class="secondary-button"
                  [disabled]="saving() || checking()"
                  (click)="clearToken()"
                >
                  Remove
                </button>
              }
            </div>
            <span class="field-hint">
              Optional. Use a read-only token; Relay stores it in the OS credential store, scoped to
              this Grafana URL and never in settings.json.
            </span>
          </div>
        </div>

        <footer class="config-footer">
          <p>Metrics and thresholds will be mapped after the datasource and dashboard are known.</p>
          <button
            type="button"
            class="secondary-button"
            [disabled]="saving() || loading() || checking() || !grafanaUrl().trim()"
            (click)="checkGrafana()"
          >
            {{ checking() ? 'Checking Grafana…' : 'Check connection' }}
          </button>
          <button
            type="button"
            class="primary-button"
            [disabled]="saving() || loading() || checking()"
            (click)="saveSettings()"
          >
            Save URLs
          </button>
        </footer>
      </section>

      @if (checkResult(); as result) {
        <section class="connection-result" aria-labelledby="connection-result-title">
          <header>
            <div>
              <h2 id="connection-result-title">Grafana is reachable</h2>
              <p>
                @if (result.version) {
                  Version {{ result.version }} ·
                }
                Checked {{ grafanaCheckedAtLabel(result) }}. This confirms Grafana access only; it
                does not indicate Leaf health.
              </p>
            </div>
            <span class="dashboard-count">
              @if (result.dashboardError) {
                Dashboard list unavailable
              } @else {
                {{ result.dashboards.length }} dashboards
              }
            </span>
          </header>
          @if (result.dashboardError) {
            <p class="dashboard-error" role="status">{{ result.dashboardError }}</p>
          } @else if (result.dashboards.length) {
            <ul class="dashboard-list" aria-label="Grafana dashboards">
              @for (dashboard of result.dashboards; track dashboard.uid) {
                <li>
                  <button
                    type="button"
                    class="dashboard-open"
                    [disabled]="saving()"
                    (click)="openDashboard(dashboard.url)"
                  >
                    {{ dashboard.title }}
                  </button>
                  @if (dashboardUrl() === dashboard.url) {
                    <span class="dashboard-default">Default</span>
                  } @else {
                    <button
                      type="button"
                      class="dashboard-use"
                      [disabled]="saving()"
                      (click)="selectDashboard(dashboard)"
                    >
                      Set default
                    </button>
                  }
                  <button
                    type="button"
                    class="dashboard-use"
                    [disabled]="saving() || inspectingPanels()"
                    (click)="inspectDashboard(dashboard)"
                  >
                    Inspect
                  </button>
                </li>
              }
            </ul>
          } @else {
            <p class="dashboard-error" role="status">No dashboards were visible to this account.</p>
          }
          @if (inspectedDashboard(); as dashboard) {
            <section class="panel-inventory" aria-label="Grafana dashboard panels">
              <h2>{{ dashboard.title }} · panel inventory</h2>
              @if (panelInventoryError()) {
                <p class="dashboard-error" role="status">{{ panelInventoryError() }}</p>
              } @else if (inspectingPanels()) {
                <p role="status">Loading panel metadata…</p>
              } @else {
                @if (dashboardPanels().truncated) {
                  <p role="status">Showing the first 200 panels.</p>
                }
                @if (dashboardPanels().panels.length) {
                  <ul class="dashboard-list">
                    @for (panel of dashboardPanels().panels; track panel.id ?? $index) {
                      <li>
                        <span>{{ panel.title || 'Untitled panel' }}</span>
                        <small>
                          #{{ panel.id ?? '—' }} · {{ panel.kind || 'Unknown type' }} ·
                          {{ panel.targetCount }} targets
                          @if (panel.datasourceType) {
                            · {{ panel.datasourceType }}
                          }
                          @if (panel.datasourceUid) {
                            · {{ panel.datasourceUid }}
                          }
                        </small>
                      </li>
                    }
                  </ul>
                } @else {
                  <p>No panels were returned for this dashboard.</p>
                }
              }
            </section>
          }
        </section>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-block-size: 100%;
    }

    .runtime {
      max-inline-size: 960px;
      margin: 0 auto;
      padding: var(--space-9) var(--space-8);
    }

    .page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-5);
      padding-block-end: var(--space-7);
      border-block-end: 1px solid var(--border-subtle);
    }

    .page-actions {
      display: flex;
      flex: none;
      flex-wrap: wrap;
      gap: var(--space-2);
    }

    h1,
    h2,
    p {
      margin: 0;
    }

    h1 {
      margin-block-start: var(--space-2);
      color: var(--text-strong);
      font-size: var(--text-20);
      font-weight: var(--weight-semibold);
      letter-spacing: -0.04em;
    }

    .page-description {
      margin-block-start: var(--space-2);
      color: var(--text-muted);
      font-size: var(--text-13);
    }

    .overview {
      padding-block: var(--space-5);
      border-block-end: 1px solid var(--border-subtle);
    }

    .overview-heading {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: var(--space-4);
      margin-block-end: var(--space-3);
    }

    .overview-heading h2 {
      color: var(--text-body);
      font-size: var(--text-14);
      font-weight: var(--weight-medium);
    }

    .overview-heading p,
    .overview-updated {
      margin-block-start: var(--space-1);
      color: var(--text-muted);
      font-size: var(--text-11);
    }

    .overview-updated {
      flex: none;
      margin-block-start: 0;
      text-align: end;
    }

    .status-grid-scroll {
      overflow-x: auto;
    }

    .status-grid {
      inline-size: 100%;
      border-collapse: collapse;
      text-align: start;
    }

    .status-grid thead th {
      padding: var(--space-2) var(--space-3);
      color: var(--text-subtle);
      font-size: var(--text-11);
      font-weight: var(--weight-medium);
      text-align: start;
      text-transform: uppercase;
      letter-spacing: var(--tracking-caps);
      border-block-end: 1px solid var(--border-subtle);
    }

    .status-grid tbody th,
    .status-grid tbody td {
      padding: var(--space-4) var(--space-3);
      vertical-align: top;
      border-block-end: 1px solid var(--border-subtle);
    }

    .status-grid tbody th {
      inline-size: 34%;
      color: var(--text-body);
      font-size: var(--text-12);
      font-weight: var(--weight-medium);
      text-align: start;
    }

    .status-grid tbody th small {
      display: block;
      margin-block-start: var(--space-1);
      color: var(--text-muted);
      font-size: var(--text-11);
      font-weight: var(--weight-regular);
    }

    .signal-cell {
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
    }

    .signal-cell p {
      padding-block-start: var(--space-1);
      color: var(--text-muted);
      font-size: var(--text-12);
      line-height: 1.5;
    }

    .open-button,
    .primary-button,
    .secondary-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-block-size: var(--control-sm);
      padding-inline: var(--space-3);
      border-radius: var(--radius-sm);
      font-size: var(--text-12);
      font-weight: var(--weight-medium);
      white-space: nowrap;
    }

    .open-button,
    .secondary-button {
      color: var(--text-body);
      border: 1px solid var(--border-subtle);
    }

    .open-button:hover:not(:disabled),
    .secondary-button:hover:not(:disabled) {
      background: var(--tint-hover);
    }

    .primary-button {
      color: var(--primary-ink);
      background: var(--primary);
    }

    .primary-button:hover:not(:disabled) {
      background: var(--primary-hover);
    }

    .open-button:disabled,
    .primary-button:disabled,
    .secondary-button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    .setup-notice {
      display: flex;
      align-items: flex-start;
      gap: var(--space-4);
      margin-block-start: var(--space-7);
      padding: var(--space-5);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: var(--bg-raised);
    }

    .notice-icon {
      display: grid;
      place-items: center;
      inline-size: var(--control-sm);
      block-size: var(--control-sm);
      flex: none;
      color: var(--text-muted);
    }

    .setup-notice h2 {
      color: var(--text-body);
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
    }

    .setup-notice p {
      margin-block-start: var(--space-2);
      color: var(--text-muted);
      font-size: var(--text-12);
      line-height: 1.5;
    }

    .config-card {
      margin-block-start: var(--space-5);
      padding: var(--space-5);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: var(--bg-raised);
    }

    .config-header,
    .config-footer {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-5);
    }

    .config-header h2 {
      color: var(--text-body);
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
    }

    .config-header p,
    .config-footer p,
    .field-hint {
      margin-block-start: var(--space-2);
      color: var(--text-muted);
      font-size: var(--text-12);
      line-height: 1.5;
    }

    .token-status {
      flex: none;
      color: var(--text-muted);
      font-size: var(--text-11);
    }

    .fields {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-5);
      margin-block-start: var(--space-5);
    }

    .field {
      display: grid;
      gap: var(--space-2);
      min-inline-size: 0;
      color: var(--text-body);
      font-size: var(--text-12);
    }

    .field input {
      inline-size: 100%;
      min-inline-size: 0;
      min-block-size: var(--control-sm);
      padding: var(--space-2) var(--space-3);
      color: var(--text-body);
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      font: inherit;
    }

    .field input:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }

    .token-field {
      grid-column: 1 / -1;
    }

    .token-input-row {
      display: flex;
      gap: var(--space-2);
    }

    .token-input-row input {
      flex: 1;
    }

    .field-hint {
      margin-block-start: 0;
    }

    .config-footer {
      align-items: center;
      margin-block-start: var(--space-5);
      padding-block-start: var(--space-4);
      border-block-start: 1px solid var(--border-subtle);
    }

    .config-footer p {
      margin-block-start: 0;
    }

    .connection-result {
      margin-block-start: var(--space-5);
      padding: var(--space-5);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: var(--bg-raised);
    }

    .connection-result header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-5);
    }

    .connection-result h2 {
      color: var(--text-body);
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
    }

    .connection-result p,
    .dashboard-count {
      margin-block-start: var(--space-2);
      color: var(--text-muted);
      font-size: var(--text-12);
      line-height: 1.5;
    }

    .dashboard-count {
      flex: none;
      margin-block-start: 0;
    }

    .dashboard-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
      gap: var(--space-2);
      margin: var(--space-4) 0 0;
      padding: 0;
      list-style: none;
    }

    .dashboard-list li {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      min-inline-size: 0;
      padding: var(--space-2);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      background: var(--bg-sunken);
    }

    .dashboard-list button {
      color: var(--text-body);
      font: inherit;
    }

    .dashboard-open {
      flex: 1;
      min-inline-size: 0;
      padding: var(--space-2);
      overflow-wrap: anywhere;
      text-align: start;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
    }

    .dashboard-use {
      flex: none;
      padding: var(--space-2);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      background: var(--bg-raised);
      white-space: nowrap;
    }

    .dashboard-open:hover:not(:disabled),
    .dashboard-use:hover:not(:disabled) {
      background: var(--tint-hover);
    }

    .dashboard-error {
      margin-block-start: var(--space-4) !important;
    }

    .error,
    .notice {
      margin-block-start: var(--space-4);
      color: var(--danger-ink);
      font-size: var(--text-12);
    }

    .notice {
      color: var(--text-muted);
    }

    .state {
      flex: none;
      padding: var(--space-1) var(--space-2);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-pill);
      color: var(--text-muted);
      font-size: var(--text-11);
      font-weight: var(--weight-medium);
    }

    .state.operational {
      color: var(--text-body);
      border-color: var(--success);
      background: var(--success-tint);
    }

    .state.stale {
      color: var(--text-body);
      border-color: var(--warning);
      background: var(--warning-tint);
    }

    @media (max-width: 620px) {
      .runtime {
        padding: var(--space-7) var(--space-4);
      }

      .fields {
        grid-template-columns: minmax(0, 1fr);
      }

      .token-field {
        grid-column: auto;
      }

      .config-header,
      .config-footer {
        flex-direction: column;
      }

      .page-header {
        flex-direction: column;
      }

      .overview-heading {
        align-items: flex-start;
        flex-direction: column;
      }

      .overview-updated {
        text-align: start;
      }

      .status-grid thead {
        position: absolute;
        inline-size: 1px;
        block-size: 1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      .status-grid,
      .status-grid tbody {
        display: block;
      }

      .status-grid tbody tr {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        padding-block: var(--space-2);
        border-block-end: 1px solid var(--border-subtle);
      }

      .status-grid tbody th,
      .status-grid tbody td {
        inline-size: auto;
        padding: var(--space-2) 0;
        border: 0;
      }

      .status-grid tbody td::before {
        display: block;
        margin-block-end: var(--space-2);
        color: var(--text-subtle);
        content: 'Production';
        font-size: var(--text-11);
        font-weight: var(--weight-medium);
        text-transform: uppercase;
        letter-spacing: var(--tracking-caps);
      }

      .signal-cell {
        flex-wrap: wrap;
      }

      .token-input-row {
        flex-wrap: wrap;
      }
    }
  `,
})
export class Runtime implements OnDestroy {
  private readonly tauri = inject(TauriBridge);
  private readonly runtimeHealthTimer: ReturnType<typeof setInterval> | null;

  protected readonly grafanaUrl = signal('');
  protected readonly dashboardUrl = signal('');
  protected readonly tokenInput = signal('');
  protected readonly tokenConfigured = signal(false);
  protected readonly tokenStatus = signal<'loading' | 'available' | 'unavailable' | 'needs-url'>(
    'needs-url',
  );
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly checking = signal(false);
  protected readonly checkResult = signal<RuntimeGrafanaCheck | null>(null);
  protected readonly inspectedDashboard = signal<RuntimeGrafanaDashboard | null>(null);
  protected readonly dashboardPanels = signal<RuntimeGrafanaPanelInventory>({
    panels: [],
    truncated: false,
  });
  protected readonly inspectingPanels = signal(false);
  protected readonly panelInventoryError = signal('');
  protected readonly leafHealth = signal<LeafHealthObservation | null>(null);
  protected readonly leafHealthState = signal<
    'checking' | 'reachable' | 'not-ready' | 'stale' | 'unknown' | 'unavailable'
  >('checking');
  protected readonly leafHealthError = signal('');
  protected readonly leafRefreshing = signal(false);
  protected readonly nexusHealth = signal<NexusReadinessObservation | null>(null);
  protected readonly nexusHealthState = signal<
    'checking' | 'ready' | 'not-ready' | 'stale' | 'unknown' | 'unavailable'
  >('checking');
  protected readonly nexusHealthError = signal('');
  protected readonly nexusRefreshing = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  private tokenStatusRequest = 0;
  private readonly onVisibilityChange = () => {
    if (!document.hidden && this.tauri.available) void this.refreshRuntimeStatus();
  };

  constructor() {
    void this.restore();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    const lastStatus = this.tauri.runtimeStatusSnapshot();
    if (lastStatus.leaf) {
      this.leafHealth.set(lastStatus.leaf);
      this.leafHealthState.set(
        this.isStale(lastStatus.leaf.checkedAt)
          ? 'stale'
          : lastStatus.leaf.healthy
            ? 'reachable'
            : 'not-ready',
      );
    }
    if (lastStatus.nexus) {
      this.nexusHealth.set(lastStatus.nexus);
      this.nexusHealthState.set(
        this.isStale(lastStatus.nexus.checkedAt)
          ? 'stale'
          : lastStatus.nexus.ready
            ? 'ready'
            : 'not-ready',
      );
    }

    if (this.tauri.available) {
      if (!document.hidden) void this.refreshRuntimeStatus();
      this.runtimeHealthTimer = setInterval(() => {
        if (document.hidden) return;
        void this.refreshRuntimeStatus();
      }, RUNTIME_STATUS_POLL_INTERVAL_MS);
    } else {
      this.leafHealthState.set('unavailable');
      this.nexusHealthState.set('unavailable');
      this.runtimeHealthTimer = null;
    }
  }

  ngOnDestroy(): void {
    if (this.runtimeHealthTimer !== null) clearInterval(this.runtimeHealthTimer);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  private async restore(): Promise<void> {
    try {
      const settings = await this.tauri.runtimeGrafanaSettings();
      this.grafanaUrl.set(settings.grafanaUrl);
      this.dashboardUrl.set(settings.dashboardUrl);
    } catch {
      this.error.set('Could not load Grafana settings.');
    }

    await this.refreshGrafanaTokenStatus(this.grafanaUrl());
    this.loading.set(false);
  }

  protected setGrafanaUrl(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    const grafanaUrl = event.target.value;
    if (normalizeWebUrl(grafanaUrl) !== normalizeWebUrl(this.grafanaUrl())) {
      this.dashboardUrl.set('');
      this.checkResult.set(null);
      this.clearPanelInventory();
      this.error.set('');
      this.notice.set('');
    }
    this.grafanaUrl.set(grafanaUrl);
    void this.refreshGrafanaTokenStatus(grafanaUrl);
  }

  protected setDashboardUrl(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.dashboardUrl.set(event.target.value);
  }

  protected setTokenInput(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.tokenInput.set(event.target.value);
  }

  private async refreshGrafanaTokenStatus(grafanaUrl: string): Promise<void> {
    const request = ++this.tokenStatusRequest;
    const normalizedUrl = normalizeWebUrl(grafanaUrl);
    this.tokenConfigured.set(false);
    if (!this.tauri.available) {
      this.tokenStatus.set('unavailable');
      return;
    }
    if (!normalizedUrl) {
      this.tokenStatus.set('needs-url');
      return;
    }

    this.tokenStatus.set('loading');
    try {
      const configured = await this.tauri.runtimeGrafanaTokenConfigured(normalizedUrl);
      if (request !== this.tokenStatusRequest) return;
      this.tokenConfigured.set(configured);
      this.tokenStatus.set('available');
    } catch {
      if (request === this.tokenStatusRequest) this.tokenStatus.set('unavailable');
    }
  }

  private isStale(checkedAt: number): boolean {
    return Date.now() - checkedAt >= RUNTIME_STATUS_STALE_AFTER_MS;
  }

  protected async refreshLeafHealth(): Promise<void> {
    if (!this.tauri.available || this.leafRefreshing()) return;

    this.leafRefreshing.set(true);
    try {
      const observation = await this.tauri.runtimeLeafHealth();
      if (!observation) throw new Error('No health observation returned.');
      this.leafHealth.set(observation);
      this.leafHealthError.set('');
      this.leafHealthState.set(observation.healthy ? 'reachable' : 'not-ready');
    } catch (error: unknown) {
      this.leafHealthError.set(
        typeof error === 'string' ? error : 'Could not confirm Leaf API liveness.',
      );
      this.leafHealthState.set(this.leafHealth() ? 'stale' : 'unknown');
    } finally {
      this.leafRefreshing.set(false);
    }
  }

  protected async refreshRuntimeStatus(): Promise<void> {
    const leafObservation = this.leafHealth();
    if (leafObservation && this.isStale(leafObservation.checkedAt))
      this.leafHealthState.set('stale');
    const nexusObservation = this.nexusHealth();
    if (nexusObservation && this.isStale(nexusObservation.checkedAt))
      this.nexusHealthState.set('stale');
    await Promise.all([this.refreshLeafHealth(), this.refreshNexusReadiness()]);
  }

  protected async refreshNexusReadiness(): Promise<void> {
    if (!this.tauri.available || this.nexusRefreshing()) return;

    this.nexusRefreshing.set(true);
    try {
      const observation = await this.tauri.runtimeNexusReadiness();
      if (!observation) throw new Error('No readiness observation returned.');
      this.nexusHealth.set(observation);
      this.nexusHealthError.set('');
      this.nexusHealthState.set(observation.ready ? 'ready' : 'not-ready');
    } catch (error: unknown) {
      this.nexusHealthError.set(
        typeof error === 'string' ? error : 'Could not confirm Nexus readiness.',
      );
      this.nexusHealthState.set(this.nexusHealth() ? 'stale' : 'unknown');
    } finally {
      this.nexusRefreshing.set(false);
    }
  }

  protected leafHealthLabel(): string {
    switch (this.leafHealthState()) {
      case 'checking':
        return 'Checking';
      case 'reachable':
        return 'Reachable';
      case 'not-ready':
        return 'Not ready';
      case 'stale':
        return 'Stale';
      case 'unknown':
        return 'Unknown';
      case 'unavailable':
        return 'Unavailable';
    }
  }

  protected leafHealthDetail(): string {
    const observation = this.leafHealth();
    if (this.leafHealthState() === 'unavailable') {
      return 'Live checks run in the Relay desktop app.';
    }
    if (this.leafHealthState() === 'checking' && !observation) {
      return 'Checking Leaf’s HTTP liveness endpoint…';
    }
    if (this.leafHealthState() === 'stale' && observation) {
      const age = this.checkedAgeLabel(observation.checkedAt);
      const previousState = observation.healthy ? 'healthy' : 'not ready';
      const reason = this.leafHealthError()
        ? `Latest check failed: ${this.leafHealthError()}`
        : 'No successful refresh arrived within the freshness window.';
      return `Last response was ${previousState} at ${this.checkedAtLabel(observation.checkedAt)} (${age}). ${reason}`;
    }
    if (this.leafHealthState() === 'not-ready' && observation) {
      return `Leaf health probe did not confirm a healthy response at ${this.checkedAtLabel(observation.checkedAt)} (${this.checkedAgeLabel(observation.checkedAt)}).`;
    }
    if (this.leafHealthState() === 'unknown') {
      return `No successful liveness response yet. ${this.leafHealthError()}`;
    }
    if (observation) {
      return `Checked ${this.checkedAtLabel(observation.checkedAt)} (${this.checkedAgeLabel(observation.checkedAt)}) · liveness only; database and Nexus are not checked.`;
    }
    return 'No liveness observation yet.';
  }

  protected nexusHealthLabel(): string {
    switch (this.nexusHealthState()) {
      case 'checking':
        return 'Checking';
      case 'ready':
        return 'Ready';
      case 'not-ready':
        return 'Not ready';
      case 'stale':
        return 'Stale';
      case 'unknown':
        return 'Unknown';
      case 'unavailable':
        return 'Unavailable';
    }
  }

  protected probeSummary(): string {
    const states = [this.leafHealthState(), this.nexusHealthState()];
    const responding = states.filter((state) => state === 'reachable' || state === 'ready').length;
    const notReady = states.filter((state) => state === 'not-ready').length;
    const stale = states.filter((state) => state === 'stale').length;
    const checking = states.filter((state) => state === 'checking').length;
    const unknown = states.filter((state) => state === 'unknown').length;
    const unavailable = states.filter((state) => state === 'unavailable').length;
    return [
      responding && `${responding} responding`,
      notReady && `${notReady} not ready`,
      stale && `${stale} stale`,
      checking && `${checking} checking`,
      unknown && `${unknown} unknown`,
      unavailable && `${unavailable} unavailable`,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  protected probeEvidence(
    observation: LeafHealthObservation | NexusReadinessObservation | null,
  ): string {
    return observation
      ? `HTTP ${observation.statusCode} · ${observation.responseHeadersMs} ms`
      : 'No response';
  }

  protected nexusHealthDetail(): string {
    const observation = this.nexusHealth();
    if (this.nexusHealthState() === 'unavailable') {
      return 'Live checks run in the Relay desktop app.';
    }
    if (this.nexusHealthState() === 'checking' && !observation) {
      return 'Checking Nexus HTTP and database readiness from Relay…';
    }
    if (this.nexusHealthState() === 'stale' && observation) {
      const result = observation.ready
        ? 'Last probe confirmed readiness'
        : 'Last probe did not confirm readiness';
      const reason = this.nexusHealthError()
        ? `Latest check failed: ${this.nexusHealthError()}`
        : 'No successful refresh arrived within the freshness window.';
      return `${result} at ${this.checkedAtLabel(observation.checkedAt)} (${this.checkedAgeLabel(observation.checkedAt)}). ${reason} The probe runs from this Relay client; it does not prove Leaf-to-Nexus connectivity.`;
    }
    if (this.nexusHealthState() === 'unknown') {
      return `No successful readiness response yet. ${this.nexusHealthError()}`;
    }
    if (observation) {
      const readiness = observation.ready
        ? 'Nexus HTTP and PostgreSQL readiness are confirmed from this Relay client.'
        : 'This response did not confirm Nexus readiness.';
      return `Checked ${this.checkedAtLabel(observation.checkedAt)} (${this.checkedAgeLabel(observation.checkedAt)}) · ${readiness} This does not prove Leaf-to-Nexus connectivity.`;
    }
    return 'No readiness observation yet.';
  }

  protected checkedAtLabel(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString();
  }

  private checkedAgeLabel(timestamp: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
  }

  protected async saveSettings(): Promise<void> {
    if (!this.tauri.available) {
      this.error.set('Grafana settings can only be saved in the Relay desktop app.');
      return;
    }
    const grafanaUrl = normalizeWebUrl(this.grafanaUrl());
    const dashboardUrl = normalizeWebUrl(this.dashboardUrl());
    if (grafanaUrl === null || dashboardUrl === null) {
      this.error.set('Enter valid HTTP or HTTPS URLs, or leave the fields blank.');
      this.notice.set('');
      return;
    }

    this.saving.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      const settings: RuntimeGrafanaSettings = { grafanaUrl, dashboardUrl };
      await this.tauri.setRuntimeGrafanaSettings(settings);
      this.grafanaUrl.set(grafanaUrl);
      this.dashboardUrl.set(dashboardUrl);
      this.notice.set('Grafana URLs saved. Metric mapping is still pending.');
    } catch {
      this.error.set('Could not save Grafana URLs.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async saveToken(): Promise<void> {
    const token = this.tokenInput().trim();
    if (!token) return;
    const grafanaUrl = normalizeWebUrl(this.grafanaUrl());
    if (!grafanaUrl) {
      this.error.set('Enter a valid Grafana URL before storing a token.');
      return;
    }
    if (!this.tauri.available) {
      this.error.set('Grafana tokens can only be stored in the Relay desktop app.');
      return;
    }
    this.tokenStatusRequest++;
    this.saving.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await this.tauri.setRuntimeGrafanaToken(token, grafanaUrl);
      this.tokenInput.set('');
      this.tokenConfigured.set(true);
      this.tokenStatus.set('available');
      this.checkResult.set(null);
      this.clearPanelInventory();
      this.notice.set('Grafana token stored in the OS credential store.');
    } catch {
      this.error.set('Could not store the Grafana token in the OS credential store.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async clearToken(): Promise<void> {
    if (!this.tauri.available) {
      this.error.set('Grafana tokens can only be removed in the Relay desktop app.');
      return;
    }
    const grafanaUrl = normalizeWebUrl(this.grafanaUrl());
    if (!grafanaUrl) {
      this.error.set('Enter a valid Grafana URL before removing its token.');
      return;
    }
    this.tokenStatusRequest++;
    this.saving.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await this.tauri.clearRuntimeGrafanaToken(grafanaUrl);
      this.tokenConfigured.set(false);
      this.tokenInput.set('');
      this.checkResult.set(null);
      this.clearPanelInventory();
      this.notice.set('Grafana token removed.');
    } catch {
      this.error.set('Could not remove the Grafana token.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async checkGrafana(): Promise<void> {
    if (!this.tauri.available) {
      this.error.set('Grafana can only be checked in the Relay desktop app.');
      return;
    }
    const grafanaUrl = normalizeWebUrl(this.grafanaUrl());
    if (!grafanaUrl) {
      this.error.set('Enter a valid Grafana URL before checking the connection.');
      return;
    }

    this.checking.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      const result = await this.tauri.checkRuntimeGrafana(grafanaUrl);
      if (!result) throw new Error('Grafana check did not return a result.');
      this.checkResult.set(result);
      this.notice.set(
        'Connection checked. Use Save URLs to persist this connection; Leaf metrics are not mapped yet.',
      );
    } catch (error: unknown) {
      this.checkResult.set(null);
      this.error.set(typeof error === 'string' ? error : 'Could not check the Grafana connection.');
    } finally {
      this.checking.set(false);
    }
  }

  protected async selectDashboard(dashboard: RuntimeGrafanaDashboard): Promise<void> {
    if (!this.tauri.available) return;
    const grafanaUrl = normalizeWebUrl(this.grafanaUrl());
    if (!grafanaUrl) return;

    this.saving.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await this.tauri.setRuntimeGrafanaSettings({
        grafanaUrl,
        dashboardUrl: dashboard.url,
      });
      this.grafanaUrl.set(grafanaUrl);
      this.dashboardUrl.set(dashboard.url);
      this.notice.set(`${dashboard.title} is now the default Grafana dashboard.`);
    } catch {
      this.error.set('Could not save the default Grafana dashboard.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async inspectDashboard(dashboard: RuntimeGrafanaDashboard): Promise<void> {
    if (!this.tauri.available) return;
    const grafanaUrl = normalizeWebUrl(this.grafanaUrl());
    if (!grafanaUrl) {
      this.panelInventoryError.set('Enter a valid Grafana URL before inspecting panels.');
      return;
    }
    this.inspectedDashboard.set(dashboard);
    this.dashboardPanels.set({ panels: [], truncated: false });
    this.panelInventoryError.set('');
    this.inspectingPanels.set(true);
    try {
      this.dashboardPanels.set(
        (await this.tauri.runtimeGrafanaDashboardPanels(dashboard.uid, grafanaUrl)) ?? {
          panels: [],
          truncated: false,
        },
      );
    } catch {
      this.panelInventoryError.set(
        'Could not read panel metadata. Check the Grafana token permissions.',
      );
    } finally {
      this.inspectingPanels.set(false);
    }
  }

  private clearPanelInventory(): void {
    this.inspectedDashboard.set(null);
    this.dashboardPanels.set({ panels: [], truncated: false });
    this.panelInventoryError.set('');
  }

  protected grafanaCheckedAtLabel(result: RuntimeGrafanaCheck): string {
    return new Date(result.checkedAt).toLocaleTimeString();
  }

  protected async openDashboard(url: string): Promise<void> {
    try {
      await this.tauri.openUrl(url);
    } catch {
      this.error.set('Could not open the Grafana dashboard.');
    }
  }

  protected async openHealthSource(url: string): Promise<void> {
    try {
      await this.tauri.openUrl(url);
    } catch {
      this.error.set('Could not open the health endpoint.');
    }
  }

  protected async openGrafana(): Promise<void> {
    const dashboardUrl = normalizeWebUrl(this.dashboardUrl());
    const grafanaUrl = normalizeWebUrl(this.grafanaUrl());
    if (dashboardUrl === null || grafanaUrl === null) {
      this.error.set('Saved Grafana URLs are invalid. Update them before opening Grafana.');
      return;
    }
    const url = dashboardUrl || grafanaUrl;
    if (!url) return;
    if (!this.tauri.available) {
      this.error.set('Grafana links open from the Relay desktop app.');
      return;
    }
    try {
      await this.tauri.openUrl(url);
    } catch {
      this.error.set('Could not open Grafana.');
    }
  }
}

function normalizeWebUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return null;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
