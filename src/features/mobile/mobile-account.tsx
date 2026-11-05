import { Icon } from '@/shared/icon';
import { NexusAccount } from '@/core/nexus-account';
import { inject } from '@/lib/inject';
import { useSignals } from '@/lib/signals';

/** Who is signed in on this phone, and the way to sign in or out. */
export function MobileAccount() {
  useSignals();
  const account = inject(NexusAccount);
  const status = account.status();

  return (
    <div className="mobile-account">
      {status.connected ? (
        <>
          <span className="mobile-account-name">
            {status.displayName || status.email || 'Nexus account'}
          </span>
          <button
            className="text-button"
            type="button"
            disabled={account.busy()}
            onClick={() => void account.logout()}
          >
            Sign out
          </button>
        </>
      ) : (
        <button
          className="rail-item mobile-sign-in"
          type="button"
          disabled={!account.available}
          onClick={() => void account.login()}
        >
          <Icon name="user" size={16} />
          <span className="module-label">
            {account.waiting() ? 'Waiting for sign-in…' : 'Sign in with Nexus'}
          </span>
        </button>
      )}
      {account.error() && (
        <p className="mobile-account-error" role="alert">
          {account.error()}
        </p>
      )}
    </div>
  );
}
