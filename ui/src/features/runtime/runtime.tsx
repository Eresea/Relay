import { Fragment } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/shared/icon';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { when } from '@/lib/jsx';
import { useController, useSignals } from '@/lib/signals';
import { inject } from '@/lib/inject';
import { signal } from '@/lib/signals';

import {
  TauriBridge,
  type LeafHealthObservation,
  type RuntimeGrafanaCheck,
  type RuntimeGrafanaDashboard,
  type RuntimeGrafanaSettings,
  type RuntimeGrafanaPanelInventory,
  type NexusReadinessObservation,
  type RuntimeSignalEvent,
} from '@/core/tauri';

const RUNTIME_STATUS_POLL_INTERVAL_MS = 30_000;
const RUNTIME_STATUS_STALE_AFTER_MS = 90_000;

import './runtime.css';

export class RuntimeState {
  private readonly tauri = inject(TauriBridge);
  private readonly runtimeHealthTimer: ReturnType<typeof setInterval> | null;

  readonly grafanaUrl = signal('');
  readonly dashboardUrl = signal('');
  readonly tokenInput = signal('');
  readonly tokenConfigured = signal(false);
  readonly tokenStatus = signal<'loading' | 'available' | 'unavailable' | 'needs-url'>('needs-url');
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly checking = signal(false);
  readonly checkResult = signal<RuntimeGrafanaCheck | null>(null);
  readonly inspectedDashboard = signal<RuntimeGrafanaDashboard | null>(null);
  readonly dashboardPanels = signal<RuntimeGrafanaPanelInventory>({
    panels: [],
    truncated: false,
  });
  readonly inspectingPanels = signal(false);
  readonly panelInventoryError = signal('');
  readonly leafHealth = signal<LeafHealthObservation | null>(null);
  readonly leafHealthState = signal<
    'checking' | 'reachable' | 'not-ready' | 'stale' | 'unknown' | 'unavailable'
  >('checking');
  readonly leafHealthError = signal('');
  readonly leafRefreshing = signal(false);
  readonly nexusHealth = signal<NexusReadinessObservation | null>(null);
  readonly nexusHealthState = signal<
    'checking' | 'ready' | 'not-ready' | 'stale' | 'unknown' | 'unavailable'
  >('checking');
  readonly nexusHealthError = signal('');
  readonly nexusRefreshing = signal(false);
  readonly runtimeEvents = signal<readonly RuntimeSignalEvent[]>([]);
  readonly error = signal('');
  readonly notice = signal('');
  private tokenStatusRequest = 0;
  private readonly onVisibilityChange = () => {
    if (!document.hidden && this.tauri.available) void this.refreshRuntimeStatus();
  };

  constructor() {
    void this.restore();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    const lastStatus = this.tauri.runtimeStatusSnapshot();
    this.runtimeEvents.set(this.tauri.runtimeSignalEventSnapshot());
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

  start(): () => void {
    return () => this.ngOnDestroy();
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

  setGrafanaUrl(grafanaUrl: string): void {
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

  async refreshLeafHealth(): Promise<void> {
    if (!this.tauri.available || this.leafRefreshing()) return;

    this.leafRefreshing.set(true);
    try {
      const observation = await this.tauri.runtimeLeafHealth();
      if (!observation) throw new Error('No health observation returned.');
      this.leafHealth.set(observation);
      this.leafHealthError.set('');
      this.leafHealthState.set(observation.healthy ? 'reachable' : 'not-ready');
      this.recordRuntimeEvent(
        'leaf',
        observation.healthy ? 'reachable' : 'not-ready',
        observation.statusCode,
        observation.responseHeadersMs,
      );
    } catch (error: unknown) {
      this.leafHealthError.set(
        typeof error === 'string' ? error : 'Could not confirm Leaf API liveness.',
      );
      const state = this.leafHealth() ? 'stale' : 'unknown';
      this.leafHealthState.set(state);
      this.recordRuntimeEvent('leaf', state);
    } finally {
      this.leafRefreshing.set(false);
    }
  }

  async refreshRuntimeStatus(): Promise<void> {
    const leafObservation = this.leafHealth();
    if (leafObservation && this.isStale(leafObservation.checkedAt))
      this.leafHealthState.set('stale');
    const nexusObservation = this.nexusHealth();
    if (nexusObservation && this.isStale(nexusObservation.checkedAt))
      this.nexusHealthState.set('stale');
    await Promise.all([this.refreshLeafHealth(), this.refreshNexusReadiness()]);
  }

  async refreshNexusReadiness(): Promise<void> {
    if (!this.tauri.available || this.nexusRefreshing()) return;

    this.nexusRefreshing.set(true);
    try {
      const observation = await this.tauri.runtimeNexusReadiness();
      if (!observation) throw new Error('No readiness observation returned.');
      this.nexusHealth.set(observation);
      this.nexusHealthError.set('');
      this.nexusHealthState.set(observation.ready ? 'ready' : 'not-ready');
      this.recordRuntimeEvent(
        'nexus',
        observation.ready ? 'ready' : 'not-ready',
        observation.statusCode,
        observation.responseHeadersMs,
      );
    } catch (error: unknown) {
      this.nexusHealthError.set(
        typeof error === 'string' ? error : 'Could not confirm Nexus readiness.',
      );
      const state = this.nexusHealth() ? 'stale' : 'unknown';
      this.nexusHealthState.set(state);
      this.recordRuntimeEvent('nexus', state);
    } finally {
      this.nexusRefreshing.set(false);
    }
  }

  leafHealthLabel(): string {
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

  leafHealthDetail(): string {
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

  nexusHealthLabel(): string {
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

  probeSummary(): string {
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

  probeEvidence(observation: LeafHealthObservation | NexusReadinessObservation | null): string {
    return observation
      ? `HTTP ${observation.statusCode} · ${observation.responseHeadersMs} ms`
      : 'No response';
  }

  runtimeEventSourceLabel(source: RuntimeSignalEvent['source']): string {
    return source === 'leaf' ? 'Leaf API' : 'Nexus API';
  }

  runtimeEventTransitionLabel(event: RuntimeSignalEvent): string {
    const current = this.runtimeEventStateLabel(event.state);
    return event.previousState
      ? `${this.runtimeEventStateLabel(event.previousState)} → ${current}`
      : `First observation · ${current}`;
  }

  runtimeEventTimeLabel(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  private runtimeEventStateLabel(state: RuntimeSignalEvent['state']): string {
    switch (state) {
      case 'reachable':
        return 'Reachable';
      case 'ready':
        return 'Ready';
      case 'not-ready':
        return 'Not ready';
      case 'stale':
        return 'Stale';
      case 'unknown':
        return 'Unknown';
    }
  }

  private recordRuntimeEvent(
    source: RuntimeSignalEvent['source'],
    state: RuntimeSignalEvent['state'],
    statusCode?: number,
    responseHeadersMs?: number,
  ): void {
    this.tauri.recordRuntimeSignalEvent(source, state, statusCode, responseHeadersMs);
    this.runtimeEvents.set(this.tauri.runtimeSignalEventSnapshot());
  }

  nexusHealthDetail(): string {
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

  checkedAtLabel(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString();
  }

  private checkedAgeLabel(timestamp: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
  }

  async saveSettings(): Promise<void> {
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

  async saveToken(): Promise<void> {
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

  async clearToken(): Promise<void> {
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

  async checkGrafana(): Promise<void> {
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

  async selectDashboard(dashboard: RuntimeGrafanaDashboard): Promise<void> {
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

  async inspectDashboard(dashboard: RuntimeGrafanaDashboard): Promise<void> {
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

  grafanaCheckedAtLabel(result: RuntimeGrafanaCheck): string {
    return new Date(result.checkedAt).toLocaleTimeString();
  }

  async openDashboard(url: string): Promise<void> {
    try {
      await this.tauri.openUrl(url);
    } catch {
      this.error.set('Could not open the Grafana dashboard.');
    }
  }

  async openHealthSource(url: string): Promise<void> {
    try {
      await this.tauri.openUrl(url);
    } catch {
      this.error.set('Could not open the health endpoint.');
    }
  }

  async openGrafana(): Promise<void> {
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

export default function Runtime() {
  useSignals();
  const s = useController(() => new RuntimeState());
  return (
    <div className="runtime">
      <section className="runtime" aria-labelledby="runtime-title">
        <header className="page-header">
          <div>
            <p className="u-caption">Operations</p>
            <h1 id="runtime-title">Runtime</h1>
            <p className="page-description">
              Leaf production status and a direct Nexus readiness check.
            </p>
          </div>
          <div className="page-actions">
            <Button
              size="sm"
              variant="outline"
              disabled={
                s.leafRefreshing() ||
                s.nexusRefreshing() ||
                (s.leafHealthState() === 'unavailable' && s.nexusHealthState() === 'unavailable')
              }
              onClick={() => {
                void s.refreshRuntimeStatus();
              }}
            >
              {s.leafRefreshing() || s.nexusRefreshing() ? 'Refreshing…' : 'Refresh status'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={s.loading() || (!s.dashboardUrl().trim() && !s.grafanaUrl().trim())}
              onClick={() => {
                void s.openGrafana();
              }}
            >
              Open Grafana
            </Button>
          </div>
        </header>

        <section className="overview" aria-labelledby="overview-title">
          <div className="overview-heading">
            <div>
              <h2 id="overview-title">Leaf · Production</h2>
              <p>Direct production probes · response headers measured from Relay</p>
            </div>
            <span className="overview-updated">{s.probeSummary()}</span>
          </div>
          <div className="status-grid-scroll">
            <table className="status-grid">
              <caption className="u-sr-only">Leaf production runtime status</caption>
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
                    <div className="signal-cell">
                      <span className="u-sr-only">Production status:</span>
                      <span
                        className={cn(
                          'state',
                          s.leafHealthState() === 'reachable' && 'operational',
                          s.leafHealthState() === 'stale' && 'stale',
                        )}
                        style={{
                          color: s.leafHealthState() === 'not-ready' ? 'var(--danger)' : undefined,
                          background:
                            s.leafHealthState() === 'not-ready' ? 'var(--danger-tint)' : undefined,
                        }}
                      >
                        {s.leafHealthLabel()} · {s.probeEvidence(s.leafHealth())}
                      </span>
                      <p>{s.leafHealthDetail()}</p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={s.leafHealthState() === 'unavailable'}
                        onClick={() => {
                          void s.openHealthSource('https://leaf.eresea.net/api/version/health');
                        }}
                      >
                        View source
                      </Button>
                    </div>
                  </td>
                </tr>
                <tr>
                  <th scope="row">
                    <span>Nexus API</span>
                    <small>Public API and database readiness</small>
                  </th>
                  <td>
                    <div className="signal-cell">
                      <span className="u-sr-only">Production status:</span>
                      <span
                        className={cn(
                          'state',
                          s.nexusHealthState() === 'ready' && 'operational',
                          s.nexusHealthState() === 'stale' && 'stale',
                        )}
                        style={{
                          color: s.nexusHealthState() === 'not-ready' ? 'var(--danger)' : undefined,
                          background:
                            s.nexusHealthState() === 'not-ready' ? 'var(--danger-tint)' : undefined,
                        }}
                      >
                        {s.nexusHealthLabel()} · {s.probeEvidence(s.nexusHealth())}
                      </span>
                      <p>{s.nexusHealthDetail()}</p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={s.nexusHealthState() === 'unavailable'}
                        onClick={() => {
                          void s.openHealthSource('https://nexus.eresea.net/readyz');
                        }}
                      >
                        View source
                      </Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="overview" aria-labelledby="history-title">
          <div className="overview-heading">
            <div>
              <h2 id="history-title">Recent probe changes</h2>
              <p>State transitions observed while Runtime was open in this Relay session</p>
            </div>
            <span className="overview-updated">Latest 10</span>
          </div>
          {s.runtimeEvents().length ? (
            <>
              <ul
                className="dashboard-list probe-history-list"
                aria-label="Recent Leaf and Nexus probe state changes"
              >
                {s.runtimeEvents().map((event) => {
                  return (
                    <Fragment key={event.id}>
                      <li>
                        <div className="signal-cell">
                          <span>{s.runtimeEventSourceLabel(event.source)}</span>
                          <span
                            className={cn(
                              'state',
                              (event.state === 'reachable' || event.state === 'ready') &&
                                'operational',
                              event.state === 'stale' && 'stale',
                            )}
                            style={{
                              color: event.state === 'not-ready' ? 'var(--danger)' : undefined,
                              background:
                                event.state === 'not-ready' ? 'var(--danger-tint)' : undefined,
                            }}
                          >
                            {s.runtimeEventTransitionLabel(event)}
                          </span>
                          <time>{s.runtimeEventTimeLabel(event.observedAt)}</time>
                          {event.statusCode !== null ? (
                            <>
                              <small>
                                HTTP {event.statusCode}
                                {event.responseHeadersMs !== null ? (
                                  <>· {event.responseHeadersMs} ms from Relay</>
                                ) : null}
                              </small>
                            </>
                          ) : null}
                        </div>
                      </li>
                    </Fragment>
                  );
                })}
              </ul>
            </>
          ) : (
            <>
              <p className="page-description">
                No probe state changes observed in this Relay session.
              </p>
            </>
          )}
        </section>

        <section className="setup-notice" role="status" aria-labelledby="setup-title">
          <span className="notice-icon">
            <Icon name="info" size={16} />
          </span>
          <div>
            <h2 id="setup-title">Runtime signal coverage is partial</h2>
            <p>
              Leaf HTTP liveness is checked directly. It does not validate application dependencies;
              Nexus readiness is checked from this Relay client and does not prove Leaf can reach
              it. Grafana metrics remain unmapped until the datasource is confirmed.
            </p>
          </div>
        </section>

        <section className="config-card" aria-labelledby="config-title">
          <header className="config-header">
            <div>
              <h2 id="config-title">Grafana connection</h2>
              <p>Connection details are optional until the Leaf Grafana setup is confirmed.</p>
            </div>
            {s.tokenConfigured() ? (
              <>
                <span className="token-status">Token stored for this Grafana URL</span>
              </>
            ) : s.tokenStatus() === 'loading' ? (
              <>
                <span className="token-status">Checking credential store</span>
              </>
            ) : s.tokenStatus() === 'unavailable' ? (
              <>
                <span className="token-status">OS credential store unavailable</span>
              </>
            ) : s.tokenStatus() === 'needs-url' ? (
              <>
                <span className="token-status">Set Grafana URL to scope a token</span>
              </>
            ) : (
              <>
                <span className="token-status">No token stored for this URL</span>
              </>
            )}
          </header>

          {s.error() ? (
            <>
              <p className="error" role="alert">
                {s.error()}
              </p>
            </>
          ) : s.notice() ? (
            <>
              <p className="notice" role="status">
                {s.notice()}
              </p>
            </>
          ) : null}

          <div className="fields">
            <Input
              label="Grafana URL"
              type="url"
              autoComplete="url"
              placeholder="https://grafana.example.net"
              value={s.grafanaUrl()}
              disabled={s.loading() || s.saving() || s.checking()}
              onValueChange={($event) => {
                void s.setGrafanaUrl($event);
              }}
            />
            <Input
              label="Dashboard URL"
              type="url"
              autoComplete="url"
              placeholder="Leave blank until known"
              value={s.dashboardUrl()}
              disabled={s.loading() || s.saving() || s.checking()}
              onValueChange={($event) => {
                void s.dashboardUrl.set($event);
              }}
            />
            <div className="field token-field">
              <div className="token-input-row">
                <Input
                  label="Grafana API token"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Leave blank until configured"
                  value={s.tokenInput()}
                  disabled={s.loading() || s.saving() || s.checking()}
                  onValueChange={($event) => {
                    void s.tokenInput.set($event);
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    s.saving() ||
                    s.checking() ||
                    s.tokenStatus() === 'loading' ||
                    !s.tokenInput().trim() ||
                    !s.grafanaUrl().trim()
                  }
                  onClick={() => {
                    void s.saveToken();
                  }}
                >
                  Store token
                </Button>
                {s.tokenConfigured() ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={s.saving() || s.checking()}
                      onClick={() => {
                        void s.clearToken();
                      }}
                    >
                      Remove
                    </Button>
                  </>
                ) : null}
              </div>
              <span className="field-hint">
                Optional. Use a read-only token; Relay stores it in the OS credential store, scoped
                to this Grafana URL and never in settings.json.
              </span>
            </div>
          </div>

          <footer className="config-footer">
            <p>
              Metrics and thresholds will be mapped after the datasource and dashboard are known.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={s.saving() || s.loading() || s.checking() || !s.grafanaUrl().trim()}
              onClick={() => {
                void s.checkGrafana();
              }}
            >
              {s.checking() ? 'Checking Grafana…' : 'Check connection'}
            </Button>
            <Button
              disabled={s.saving() || s.loading() || s.checking()}
              onClick={() => {
                void s.saveSettings();
              }}
            >
              Save URLs
            </Button>
          </footer>
        </section>

        {when(s.checkResult(), (result) => (
          <>
            <section className="connection-result" aria-labelledby="connection-result-title">
              <header>
                <div>
                  <h2 id="connection-result-title">Grafana is reachable</h2>
                  <p>
                    {result.version ? <>Version {result.version} ·</> : null}
                    Checked {s.grafanaCheckedAtLabel(result)}. This confirms Grafana access only; it
                    does not indicate Leaf health.
                  </p>
                </div>
                <span className="dashboard-count">
                  {result.dashboardError ? (
                    <>Dashboard list unavailable</>
                  ) : (
                    <>{result.dashboards.length} dashboards</>
                  )}
                </span>
              </header>
              {result.dashboardError ? (
                <>
                  <p className="dashboard-error" role="status">
                    {result.dashboardError}
                  </p>
                </>
              ) : result.dashboards.length ? (
                <>
                  <ul className="dashboard-list" aria-label="Grafana dashboards">
                    {result.dashboards.map((dashboard) => {
                      return (
                        <Fragment key={dashboard.uid}>
                          <li>
                            <Button
                              variant="link"
                              size="sm"
                              disabled={s.saving()}
                              onClick={() => {
                                void s.openDashboard(dashboard.url);
                              }}
                            >
                              {dashboard.title}
                            </Button>
                            {s.dashboardUrl() === dashboard.url ? (
                              <>
                                <span className="dashboard-default">Default</span>
                              </>
                            ) : (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={s.saving()}
                                  onClick={() => {
                                    void s.selectDashboard(dashboard);
                                  }}
                                >
                                  Set default
                                </Button>
                              </>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={s.saving() || s.inspectingPanels()}
                              onClick={() => {
                                void s.inspectDashboard(dashboard);
                              }}
                            >
                              Inspect
                            </Button>
                          </li>
                        </Fragment>
                      );
                    })}
                  </ul>
                </>
              ) : (
                <>
                  <p className="dashboard-error" role="status">
                    No dashboards were visible to this account.
                  </p>
                </>
              )}
              {when(s.inspectedDashboard(), (dashboard) => (
                <>
                  <section className="panel-inventory" aria-label="Grafana dashboard panels">
                    <h2>{dashboard.title} · panel inventory</h2>
                    {s.panelInventoryError() ? (
                      <>
                        <p className="dashboard-error" role="status">
                          {s.panelInventoryError()}
                        </p>
                      </>
                    ) : s.inspectingPanels() ? (
                      <>
                        <p role="status">Loading panel metadata…</p>
                      </>
                    ) : (
                      <>
                        {s.dashboardPanels().truncated ? (
                          <>
                            <p role="status">Showing the first 200 panels.</p>
                          </>
                        ) : null}
                        {s.dashboardPanels().panels.length ? (
                          <>
                            <ul className="dashboard-list">
                              {s.dashboardPanels().panels.map((panel, $index) => {
                                return (
                                  <Fragment key={panel.id ?? $index}>
                                    <li>
                                      <span>{panel.title || 'Untitled panel'}</span>
                                      <small>
                                        #{panel.id ?? '—'} · {panel.kind || 'Unknown type'} ·
                                        {panel.targetCount} targets
                                        {panel.datasourceType ? (
                                          <>· {panel.datasourceType}</>
                                        ) : null}
                                        {panel.datasourceUid ? <>· {panel.datasourceUid}</> : null}
                                      </small>
                                    </li>
                                  </Fragment>
                                );
                              })}
                            </ul>
                          </>
                        ) : (
                          <>
                            <p>No panels were returned for this dashboard.</p>
                          </>
                        )}
                      </>
                    )}
                  </section>
                </>
              ))}
            </section>
          </>
        ))}
      </section>
    </div>
  );
}
