import { inject } from '@/lib/inject';
import { computed, useSignals } from '@/lib/signals';
import { cn } from '@/lib/utils';

import { UpdateCenter } from './update-center';
import './update-status-bar.css';

const center = () => inject(UpdateCenter);

const progress = computed(() => {
  const { downloadedBytes, contentLength } = center().snapshot();
  if (!contentLength || contentLength <= 0) return null;
  return Math.min(100, Math.round((downloadedBytes / contentLength) * 100));
});

const LABEL = {
  checking: 'Checking for updates',
  available: 'Update available',
  downloading: 'Downloading update',
  ready: 'Update ready to install',
  installing: 'Applying update',
  error: 'Update check failed',
  idle: 'Relay is up to date',
} as const;

/** The version in the status bar, and the one control for the update flow. */
export function UpdateStatusBar() {
  useSignals();
  const snapshot = center().snapshot();
  const label = LABEL[snapshot.state];
  const percent = progress();
  const trackVisible = snapshot.state === 'downloading' || snapshot.state === 'installing';

  const activate = () => {
    if (snapshot.state === 'idle' || snapshot.state === 'error') void center().check();
    if (snapshot.state === 'available') void center().download();
    if (snapshot.state === 'ready') void center().install();
  };

  return (
    <div className="update-status">
      <div className="update-wrap" data-state={snapshot.state}>
        <button
          type="button"
          className="indicator"
          aria-label={label}
          title={label}
          onClick={activate}
        >
          <span className="dot" aria-hidden="true" />
          {trackVisible && (
            <span className={cn('track', percent === null && 'indeterminate')}>
              {percent !== null && <span className="fill" style={{ inlineSize: `${percent}%` }} />}
            </span>
          )}
          <span className="version">
            {/^\d/.test(snapshot.currentVersion)
              ? `v${snapshot.currentVersion}`
              : 'Development build'}
          </span>
          <span className="u-sr-only">{label}</span>
        </button>
      </div>
    </div>
  );
}
