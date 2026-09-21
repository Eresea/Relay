/**
 * The one channel the core pushes through, mirroring
 * src-tauri/src/events.rs field for field (verified by a Rust test that
 * asserts the exact wire JSON — see events.rs). A new variant there needs a
 * new case here and nothing else: no new listener, no new subscription.
 */
export type NotificationStatus = 'running' | 'waiting' | 'blocked' | 'done';

export type NotificationAction =
  | { readonly id: 'open'; readonly label: string; readonly url: string }
  | { readonly id: 'cancel'; readonly label: string };

export interface NotificationPayload {
  readonly notificationId: string;
  readonly jobId: string;
  readonly hueSource: string;
  readonly title: string;
  readonly detail?: string;
  readonly icon?: string;
  readonly status: NotificationStatus;
  /** Absent hides the progress track — never synthesise a percentage. */
  readonly progress?: number;
  /** Completed notifications only; starts once this item reaches the front. */
  readonly autoDismissMs?: number;
  readonly actions?: readonly NotificationAction[];
}

export interface NotificationRecord extends NotificationPayload {
  readonly read: boolean;
  readonly createdAt: number;
}

export type AppEvent =
  | { readonly type: 'commandsChanged' }
  | { readonly type: 'openSettingsRequested' }
  | { readonly type: 'openVaultRequested' }
  | { readonly type: 'openGithubRequested' }
  | ({ readonly type: 'notification' } & NotificationPayload)
  | { readonly type: 'notificationDone'; readonly jobId: string; readonly ok: boolean };
