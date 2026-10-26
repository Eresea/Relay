import { Icon } from '@/shared/icon';
import { useSignals } from '@/lib/signals';
import { Gmail } from '@/features/gmail/gmail';
import { Github } from '@/features/github/github';

import './mobile-connections.css';

export function MobileConnections() {
  useSignals();
  return (
    <div className="mobile-connections">
      <section className="connections">
        <div className="connections-intro">
          <p className="eyebrow">Relay sources</p>
          <p className="intro-copy">
            Connect the services that should feed your dashboard and notifications.
          </p>
        </div>

        <details className="connection-card" open>
          <summary>
            <span className="connection-icon">
              <Icon name="library" size={16} />
            </span>
            <span className="connection-heading">
              <strong>GitHub</strong>
              <span>Pull requests, reviews, and CI</span>
            </span>
            <Icon className="summary-chevron" name="chevron-down" size={16} />
          </summary>
          <div className="connection-body">
            <Github />
          </div>
        </details>

        <details className="connection-card">
          <summary>
            <span className="connection-icon">
              <Icon name="inbox" size={16} />
            </span>
            <span className="connection-heading">
              <strong>Gmail</strong>
              <span>Inbox activity and important mail</span>
            </span>
            <Icon className="summary-chevron" name="chevron-down" size={16} />
          </summary>
          <div className="connection-body">
            <Gmail />
          </div>
        </details>
      </section>
    </div>
  );
}
