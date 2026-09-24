import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { TauriBridge, type RuntimeGrafanaCheck, type RuntimeGrafanaSettings } from '@core/tauri';
import { Icon } from '@shared/icon';

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
          <p class="page-description">Service status for Leaf and its dependencies.</p>
        </div>
        <button
          type="button"
          class="open-button"
          [disabled]="loading() || (!dashboardUrl().trim() && !grafanaUrl().trim())"
          (click)="openGrafana()"
        >
          Open Grafana
        </button>
      </header>

      <section class="setup-notice" role="status" aria-labelledby="setup-title">
        <span class="notice-icon"><rl-icon name="info" [size]="16" /></span>
        <div>
          <h2 id="setup-title">No runtime signals configured</h2>
          <p>
            URLs and a token can be saved below. Status remains unknown until the Leaf datasource
            and dashboard panels are mapped.
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
            <span class="token-status">Token stored</span>
          } @else if (tokenStatus() === 'loading') {
            <span class="token-status">Checking credential store</span>
          } @else if (tokenStatus() === 'unavailable') {
            <span class="token-status">OS credential store unavailable</span>
          } @else {
            <span class="token-status">No token stored</span>
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
                [disabled]="saving() || checking() || !tokenInput().trim()"
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
              Optional. Use a read-only token; Relay stores it in the OS credential store, never
              settings.json.
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
                Checked {{ checkedAtLabel(result) }}. This confirms Grafana access only; it does not
                indicate Leaf health.
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
                  <button type="button" (click)="openDashboard(dashboard.url)">
                    {{ dashboard.title }}
                  </button>
                </li>
              }
            </ul>
          } @else {
            <p class="dashboard-error" role="status">No dashboards were visible to this account.</p>
          }
        </section>
      }

      <section class="services" aria-label="Leaf production services">
        <article class="service-card">
          <div class="service-heading">
            <div>
              <h2>Leaf API</h2>
              <p>Production service</p>
            </div>
            <span class="state unknown">Unknown</span>
          </div>
          <p class="service-detail">No health signal configured.</p>
        </article>

        <article class="service-card">
          <div class="service-heading">
            <div>
              <h2>Nexus dependency</h2>
              <p>Leaf's upstream service</p>
            </div>
            <span class="state unknown">Unknown</span>
          </div>
          <p class="service-detail">No Leaf-facing health signal configured.</p>
        </article>
      </section>
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

    .setup-notice p,
    .service-heading p,
    .service-detail {
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

    .dashboard-list button {
      inline-size: 100%;
      padding: var(--space-3);
      color: var(--text-body);
      text-align: start;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      background: var(--bg-sunken);
      font: inherit;
    }

    .dashboard-list button:hover {
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

    .services {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
      gap: var(--space-4);
      margin-block-start: var(--space-5);
    }

    .service-card {
      min-inline-size: 0;
      padding: var(--space-5);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: var(--bg-raised);
    }

    .service-heading {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-4);
    }

    .service-heading h2 {
      color: var(--text-body);
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
    }

    .service-heading p {
      font-size: var(--text-11);
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

    .service-detail {
      padding-block-start: var(--space-4);
      border-block-start: 1px solid var(--border-subtle);
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

      .token-input-row {
        flex-wrap: wrap;
      }
    }
  `,
})
export class Runtime {
  private readonly tauri = inject(TauriBridge);

  protected readonly grafanaUrl = signal('');
  protected readonly dashboardUrl = signal('');
  protected readonly tokenInput = signal('');
  protected readonly tokenConfigured = signal(false);
  protected readonly tokenStatus = signal<'loading' | 'available' | 'unavailable'>('loading');
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly checking = signal(false);
  protected readonly checkResult = signal<RuntimeGrafanaCheck | null>(null);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  constructor() {
    void this.restore();
  }

  private async restore(): Promise<void> {
    try {
      const settings = await this.tauri.runtimeGrafanaSettings();
      this.grafanaUrl.set(settings.grafanaUrl);
      this.dashboardUrl.set(settings.dashboardUrl);
    } catch {
      this.error.set('Could not load Grafana settings.');
    }

    try {
      if (!this.tauri.available) throw new Error('Runtime settings require the Relay desktop app.');
      this.tokenConfigured.set(await this.tauri.runtimeGrafanaTokenConfigured());
      this.tokenStatus.set('available');
    } catch {
      this.tokenStatus.set('unavailable');
    } finally {
      this.loading.set(false);
    }
  }

  protected setGrafanaUrl(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.grafanaUrl.set(event.target.value);
  }

  protected setDashboardUrl(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.dashboardUrl.set(event.target.value);
  }

  protected setTokenInput(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.tokenInput.set(event.target.value);
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
    if (!this.tauri.available) {
      this.error.set('Grafana tokens can only be stored in the Relay desktop app.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await this.tauri.setRuntimeGrafanaToken(token);
      this.tokenInput.set('');
      this.tokenConfigured.set(true);
      this.tokenStatus.set('available');
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
    this.saving.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await this.tauri.clearRuntimeGrafanaToken();
      this.tokenConfigured.set(false);
      this.tokenInput.set('');
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
    const dashboardUrl = normalizeWebUrl(this.dashboardUrl());
    if (!grafanaUrl || dashboardUrl === null) {
      this.error.set('Enter a valid Grafana URL before checking the connection.');
      return;
    }

    this.checking.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      const settings: RuntimeGrafanaSettings = { grafanaUrl, dashboardUrl };
      await this.tauri.setRuntimeGrafanaSettings(settings);
      this.grafanaUrl.set(grafanaUrl);
      this.dashboardUrl.set(dashboardUrl);
      const result = await this.tauri.checkRuntimeGrafana();
      if (!result) throw new Error('Grafana check did not return a result.');
      this.checkResult.set(result);
      this.notice.set('Grafana connection checked. Leaf metrics are not mapped yet.');
    } catch (error: unknown) {
      this.checkResult.set(null);
      this.error.set(typeof error === 'string' ? error : 'Could not check the Grafana connection.');
    } finally {
      this.checking.set(false);
    }
  }

  protected checkedAtLabel(result: RuntimeGrafanaCheck): string {
    return new Date(result.checkedAt).toLocaleTimeString();
  }

  protected async openDashboard(url: string): Promise<void> {
    try {
      await this.tauri.openUrl(url);
    } catch {
      this.error.set('Could not open the Grafana dashboard.');
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
