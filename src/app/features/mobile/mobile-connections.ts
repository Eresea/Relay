import { ChangeDetectionStrategy, Component } from '@angular/core';

import { Gmail } from '@features/gmail/gmail';
import { Github } from '@features/github/github';
import { Icon } from '@shared/icon';

@Component({
  selector: 'rl-mobile-connections',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Github, Gmail, Icon],
  template: `
    <section class="connections">
      <div class="connections-intro">
        <p class="eyebrow">Relay sources</p>
        <p class="intro-copy">
          Connect the services that should feed your dashboard and notifications.
        </p>
      </div>

      <details class="connection-card" open>
        <summary>
          <span class="connection-icon"><rl-icon name="library" [size]="16" /></span>
          <span class="connection-heading">
            <strong>GitHub</strong>
            <span>Pull requests, reviews, and CI</span>
          </span>
          <rl-icon class="summary-chevron" name="chevron-down" [size]="16" />
        </summary>
        <div class="connection-body"><rl-github /></div>
      </details>

      <details class="connection-card">
        <summary>
          <span class="connection-icon"><rl-icon name="inbox" [size]="16" /></span>
          <span class="connection-heading">
            <strong>Gmail</strong>
            <span>Inbox activity and important mail</span>
          </span>
          <rl-icon class="summary-chevron" name="chevron-down" [size]="16" />
        </summary>
        <div class="connection-body"><rl-gmail /></div>
      </details>
    </section>
  `,
  styles: `
    :host {
      display: block;
    }

    .connections {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-5);
    }

    .connections-intro {
      margin-block-end: var(--space-2);
    }

    .intro-copy {
      margin-block-start: var(--space-2);
      color: var(--text-muted);
      font-size: var(--text-14);
      line-height: 1.5;
    }

    .connection-card {
      overflow: hidden;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      background: var(--bg-raised);
    }

    .connection-card > summary {
      display: flex;
      align-items: center;
      min-block-size: 72px;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
      cursor: pointer;
      list-style: none;
    }

    .connection-card > summary::-webkit-details-marker {
      display: none;
    }

    .connection-card > summary:hover,
    .connection-card > summary:focus-visible {
      background: var(--tint-hover);
    }

    .connection-card[open] > summary {
      border-block-end: 1px solid var(--border-subtle);
    }

    .connection-icon {
      display: grid;
      flex: none;
      place-items: center;
      inline-size: 36px;
      block-size: 36px;
      color: var(--primary-ink);
      background: var(--tint-selected);
      border-radius: var(--radius-md);
    }

    .connection-heading {
      display: flex;
      min-inline-size: 0;
      flex: 1;
      flex-direction: column;
      gap: var(--space-1);
    }

    .connection-heading strong {
      color: var(--text-body);
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
    }

    .connection-heading span {
      overflow: hidden;
      color: var(--text-muted);
      font-size: var(--text-12);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .summary-chevron {
      color: var(--text-muted);
      transition: transform 160ms var(--ease-standard);
    }

    .connection-card[open] .summary-chevron {
      transform: rotate(180deg);
    }

    .connection-body {
      padding: var(--space-4);
    }
  `,
})
export class MobileConnections {}
