/**
 * The one channel the core pushes through, mirroring
 * src-tauri/src/events.rs field for field (verified by a Rust test that
 * asserts the exact wire JSON — see events.rs). A new variant there needs a
 * new case here and nothing else: no new listener, no new subscription.
 */
export type NotificationStatus = 'running' | 'waiting' | 'blocked' | 'done';

export interface NotificationPayload {
  readonly jobId: string;
  readonly hueSource: string;
  readonly title: string;
  readonly detail?: string;
  readonly icon?: string;
  readonly status: NotificationStatus;
  /** Absent hides the progress track — never synthesise a percentage. */
  readonly progress?: number;
}

export type AppEvent =
  | { readonly type: 'commandsChanged' }
  | { readonly type: 'openSettingsRequested' }
  | { readonly type: 'openVaultRequested' }
  | { readonly type: 'openGithubRequested' }
  | ({ readonly type: 'notification' } & NotificationPayload)
  | { readonly type: 'notificationDone'; readonly jobId: string; readonly ok: boolean };
