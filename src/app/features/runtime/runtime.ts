import { ChangeDetectionStrategy, Component } from '@angular/core';

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
          <p class="page-description">Live service status for Leaf and its dependencies.</p>
        </div>
      </header>

      <section class="setup-notice" role="status" aria-labelledby="setup-title">
        <span class="notice-icon"><rl-icon name="info" [size]="16" /></span>
        <div>
          <h2 id="setup-title">Grafana is not configured</h2>
          <p>
            Leaf's production signals will appear here after its Grafana connection and read-only
            metrics are configured.
          </p>
        </div>
      </section>

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
    }
  `,
})
export class Runtime {}
