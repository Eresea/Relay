import { Injectable } from '@angular/core';

import type { LazyStore } from '@tauri-apps/plugin-store';

import type { AppEvent, NotificationRecord, UpdateSnapshot } from './events';

/**
 * The boundary between the Angular app and the Rust core.
 *
 * Every `invoke` and every event subscription the app makes goes through
 * here, so that (a) running in a plain browser during `ng serve` degrades to
 * a no-op instead of throwing, and (b) there is one place to look for the
 * full command surface.
 */
@Injectable({ providedIn: 'root' })
export class TauriBridge {
  readonly available = '__TAURI_INTERNALS__' in window;
  private latestRuntimeStatus: RuntimeStatusSnapshot = { leaf: null, nexus: null };
  private runtimeSignalEvents: RuntimeSignalEvent[] = [];
  private nextRuntimeSignalEventId = 0;

  /** Hides the palette window without destroying it — reopening must be instant. */
  async dismissPalette(): Promise<void> {
    await this.invoke('dismiss_palette');
  }

  /**
   * Runs a command the Rust side owns. `command` mirrors
   * src-tauri/src/commands.rs's `CoreCommand` exactly — an id, and args for
   * whichever variants carry them — verified there by a test that every
   * `core_commands()` id actually deserializes into a real variant, so a
   * mismatch here fails in CI rather than silently doing nothing.
   */
  async runCoreCommand(command: CoreCommand): Promise<void> {
    await this.invoke('run_core_command', { command });
  }

  /** Requests cooperative cancellation; the job notices at its next checkpoint. */
  async cancelJob(jobId: string): Promise<void> {
    await this.invoke('cancel_job', { jobId });
  }

  /** A pull-based check alongside the push-based `notificationDone` event. */
  async isJobRunning(jobId: string): Promise<boolean> {
    return (await this.invoke<boolean>('is_job_running', { jobId })) ?? false;
  }

  /** Commands contributed by the Rust side, merged into the registry at startup. */
  async coreCommands(): Promise<readonly CoreCommandMeta[]> {
    return (await this.invoke<CoreCommandMeta[]>('core_commands')) ?? [];
  }

  /** Minimizes the current window to the taskbar/dock. */
  async minimizeWindow(): Promise<void> {
    if (!this.available) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().minimize();
  }

  /** Toggles the current window between maximized and its previous size. */
  async toggleMaximizeWindow(): Promise<void> {
    if (!this.available) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().toggleMaximize();
  }

  /** Closes the current window. On the main window this quits Relay's visible surface, not the tray process. */
  async closeWindow(): Promise<void> {
    if (!this.available) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  }

  /** Whether the current window is currently maximized. */
  async isWindowMaximized(): Promise<boolean> {
    if (!this.available) return false;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().isMaximized();
  }

  /**
   * Fires whenever the current window is resized, which includes every
   * maximize/restore toggle. Callers re-check `isWindowMaximized()` on each
   * call rather than have this report the new state itself, since Tauri's
   * event only signals that a resize happened.
   */
  async onWindowResized(handler: () => void): Promise<() => void> {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op: nothing to unsubscribe from when there is no live Tauri event system
    if (!this.available) return () => {};
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().onResized(() => handler());
  }

  /**
   * Fires whenever the current window gains or loses OS focus. The overlay
   * windows are created once and shown/hidden rather than recreated (see
   * `overlay.rs`), so a webview's own load event never fires again after the
   * first show — this is how a surface notices "I'm back on screen."
   */
  async onWindowFocusChanged(handler: (focused: boolean) => void): Promise<() => void> {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op: nothing to unsubscribe from when there is no live Tauri event system
    if (!this.available) return () => {};
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().onFocusChanged(({ payload: focused }) => handler(focused));
  }

  /**
   * Subscribes to the core's single event channel. Returns the unlisten
   * function; callers dispose it on teardown. A no-op outside Tauri, so
   * ng serve keeps working without a live core — `handler` is simply never
   * called.
   */
  async onEvent(handler: (event: AppEvent) => void): Promise<() => void> {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- intentional no-op: nothing to unsubscribe from when there is no live Tauri event system
    if (!this.available) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen<AppEvent>('relay://event', (message) => handler(message.payload));
  }

  async notificationsList(): Promise<readonly NotificationRecord[]> {
    return (await this.invoke<NotificationRecord[]>('notifications_list')) ?? [];
  }

  async notificationsMarkRead(notificationIds: readonly string[]): Promise<void> {
    await this.invoke('notifications_mark_read', { notificationIds });
  }

  async notificationsClear(): Promise<void> {
    await this.invoke('notifications_clear');
  }

  async mobileUpdateCheck(): Promise<MobileUpdate | null> {
    return this.invoke<MobileUpdate>('mobile_update_check');
  }

  async updateStatus(): Promise<UpdateSnapshot> {
    return (
      (await this.invoke<UpdateSnapshot>('update_status')) ?? {
        state: 'idle',
        currentVersion: 'dev',
        downloadedBytes: 0,
      }
    );
  }

  async updateCheck(): Promise<void> {
    await this.invoke('update_check');
  }

  async updateDownload(): Promise<void> {
    await this.invoke('update_download');
  }

  async updateInstall(): Promise<void> {
    await this.invoke('update_install');
  }

  /** Opens a URL in the user's default browser. A no-op outside Tauri. */
  async openUrl(url: string): Promise<void> {
    if (!this.available) return;
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  }

  /** Opens a local file or folder in the user's default application. */
  async openPath(path: string): Promise<void> {
    if (!this.available) return;
    const { openPath } = await import('@tauri-apps/plugin-opener');
    await openPath(path);
  }

  /** Opens a local workspace in the platform terminal. */
  async openTerminal(path: string): Promise<void> {
    await this.invoke('open_terminal', { path });
  }

  async runProjectAction(path: string, action: ProjectActionRequest): Promise<void> {
    await this.invoke('project_action', { path, action });
  }

  async scanWorkspaces(): Promise<readonly WorkspaceSummary[]> {
    return (await this.invoke<WorkspaceSummary[]>('scan_workspaces')) ?? [];
  }

  async codexSend(
    prompt: string,
    workingDirectory: string,
    threadId: string | null,
  ): Promise<CodexRun> {
    const result = await this.invoke<CodexRun>('codex_send', {
      prompt,
      workingDirectory,
      threadId,
    });
    if (!result) throw new Error('Codex returned no result.');
    return result;
  }

  async codexListThreads(cursor: string | null = null): Promise<CodexThreadPage> {
    const result = await this.invoke<CodexThreadPage>('codex_list_threads', { cursor });
    if (!result) throw new Error('Codex returned no thread list.');
    return result;
  }

  async codexReadThread(threadId: string): Promise<CodexThreadDetails> {
    const result = await this.invoke<CodexThreadDetails>('codex_read_thread', { threadId });
    if (!result) throw new Error('Codex returned no thread.');
    return result;
  }

  async codexOlderTurns(threadId: string, cursor: string): Promise<CodexTurnPage> {
    const result = await this.invoke<CodexTurnPage>('codex_older_turns', { threadId, cursor });
    if (!result) throw new Error('Codex returned no earlier turns.');
    return result;
  }

  async githubRepositories(): Promise<readonly GithubRepositorySummary[]> {
    return (await this.invoke<GithubRepositorySummary[]>('github_repositories')) ?? [];
  }

  async githubRegisterWebhooks(repositories: readonly string[]): Promise<readonly string[]> {
    return (await this.invoke<string[]>('github_register_webhooks', { repositories })) ?? [];
  }

  async githubWebhookRepositories(): Promise<readonly string[]> {
    return (await this.invoke<string[]>('github_webhook_repositories')) ?? [];
  }

  async githubUnregisterWebhook(repository: string): Promise<void> {
    await this.invoke('github_unregister_webhook', { repository });
  }

  async githubPullRequests(includeClosed = false): Promise<readonly GithubPullRequestSummary[]> {
    return (
      (await this.invoke<GithubPullRequestSummary[]>('github_pull_requests', { includeClosed })) ??
      []
    );
  }

  async runtimeGrafanaSettings(): Promise<RuntimeGrafanaSettings> {
    const stored = await this.getSetting<Partial<RuntimeGrafanaSettings> | null>(
      'runtime.grafana',
      null,
    );
    return {
      grafanaUrl: typeof stored?.grafanaUrl === 'string' ? stored.grafanaUrl : '',
      dashboardUrl: typeof stored?.dashboardUrl === 'string' ? stored.dashboardUrl : '',
    };
  }

  async setRuntimeGrafanaSettings(settings: RuntimeGrafanaSettings): Promise<void> {
    await this.setSetting('runtime.grafana', settings);
  }

  async runtimeGrafanaTokenConfigured(grafanaUrl: string): Promise<boolean> {
    return (
      (await this.invoke<boolean>('runtime_grafana_token_configured', { grafanaUrl })) ?? false
    );
  }

  async setRuntimeGrafanaToken(token: string, grafanaUrl: string): Promise<void> {
    await this.invoke('runtime_grafana_set_token', { token, grafanaUrl });
  }

  async clearRuntimeGrafanaToken(grafanaUrl: string): Promise<void> {
    await this.invoke('runtime_grafana_clear_token', { grafanaUrl });
  }

  async checkRuntimeGrafana(grafanaUrl: string): Promise<RuntimeGrafanaCheck | null> {
    return this.invoke<RuntimeGrafanaCheck>('runtime_grafana_check', { grafanaUrl });
  }

  async runtimeGrafanaDashboardPanels(
    uid: string,
    grafanaUrl: string,
  ): Promise<RuntimeGrafanaPanelInventory | null> {
    return this.invoke<RuntimeGrafanaPanelInventory>('runtime_grafana_dashboard_panels', {
      uid,
      grafanaUrl,
    });
  }

  async runtimeLeafHealth(): Promise<LeafHealthObservation | null> {
    const observation = await this.invoke<LeafHealthObservation>('runtime_leaf_health');
    if (observation) this.latestRuntimeStatus = { ...this.latestRuntimeStatus, leaf: observation };
    return observation;
  }

  async runtimeNexusReadiness(): Promise<NexusReadinessObservation | null> {
    const observation = await this.invoke<NexusReadinessObservation>('runtime_nexus_readiness');
    if (observation) this.latestRuntimeStatus = { ...this.latestRuntimeStatus, nexus: observation };
    return observation;
  }

  runtimeStatusSnapshot(): RuntimeStatusSnapshot {
    return this.latestRuntimeStatus;
  }

  recordRuntimeSignalEvent(
    source: RuntimeSignalEvent['source'],
    state: RuntimeSignalEvent['state'],
    statusCode?: number,
    responseHeadersMs?: number,
  ): void {
    const previous = [...this.runtimeSignalEvents]
      .reverse()
      .find((event) => event.source === source);
    if (previous?.state === state) return;
    this.runtimeSignalEvents.push({
      id: ++this.nextRuntimeSignalEventId,
      source,
      state,
      previousState: previous?.state ?? null,
      observedAt: Date.now(),
      statusCode: statusCode ?? null,
      responseHeadersMs: responseHeadersMs ?? null,
    });
    this.runtimeSignalEvents = this.runtimeSignalEvents.slice(-10);
  }

  runtimeSignalEventSnapshot(): readonly RuntimeSignalEvent[] {
    return this.runtimeSignalEvents.slice().reverse();
  }

  private settingsStore: LazyStore | null = null;

  /**
   * Reads a persisted setting from `settings.json` in the OS app-data
   * directory — the one real, on-disk settings store, as opposed to a
   * per-window UI preference like theme. `fallback` covers both "never set"
   * and running outside Tauri.
   */
  async getSetting<T>(key: string, fallback: T): Promise<T> {
    if (!this.available) return fallback;
    const store = await this.getSettingsStore();
    const value = await store.get<T>(key);
    return value ?? fallback;
  }

  /** Persists a setting to `settings.json`. */
  async setSetting(key: string, value: unknown): Promise<void> {
    if (!this.available) return;
    const store = await this.getSettingsStore();
    await store.set(key, value);
  }

  private async getSettingsStore(): Promise<LazyStore> {
    // A `LazyStore` only touches the filesystem on first get/set, so
    // constructing it here rather than at module load keeps this a no-op
    // outside Tauri, matching every other method on this bridge.
    this.settingsStore ??= new (await import('@tauri-apps/plugin-store')).LazyStore(
      'settings.json',
    );
    return this.settingsStore;
  }

  /** Whether Gmail is connected, mid-handshake, or neither. */
  async gmailStatus(): Promise<GmailStatus> {
    return (
      (await this.invoke<GmailStatus>('gmail_status')) ?? {
        connected: false,
        connecting: false,
        accountEmail: null,
      }
    );
  }

  async gmailGetSettings(): Promise<GmailSettings> {
    return (
      (await this.invoke<GmailSettings>('gmail_get_settings')) ?? {
        rules: { notifyAll: false, notifyImportant: true, custom: [] },
        pollIntervalSecs: 60,
      }
    );
  }

  async gmailSetSettings(settings: GmailSettings): Promise<void> {
    await this.invoke('gmail_set_settings', { settings });
  }

  /**
   * Opens the system browser to Google's consent screen and resolves once
   * the loopback redirect completes the handshake — or rejects on
   * cancellation, timeout, or a sign-in error. Long-running by design; the
   * caller shows a "waiting for the browser" state until it settles.
   */
  async gmailConnect(): Promise<string> {
    const email = await this.invoke<string>('gmail_connect');
    if (email === null) throw new Error('Gmail connect is unavailable outside Tauri');
    return email;
  }

  async gmailCancelConnect(): Promise<void> {
    await this.invoke('gmail_cancel_connect');
  }

  async gmailDisconnect(): Promise<void> {
    await this.invoke('gmail_disconnect');
  }

  /** Whether Relay is registered to launch automatically at login. */
  async isAutostartEnabled(): Promise<boolean> {
    if (!this.available) return false;
    const { isEnabled } = await import('@tauri-apps/plugin-autostart');
    return isEnabled();
  }

  /** Enables or disables launching Relay automatically at login, hidden — the same as any other launch. */
  async setAutostart(enabled: boolean): Promise<void> {
    if (!this.available) return;
    const { enable, disable } = await import('@tauri-apps/plugin-autostart');
    await (enabled ? enable() : disable());
  }

  /** Whether a vault has been created, and whether it is currently unlocked. */
  async vaultStatus(): Promise<VaultStatus> {
    return (await this.invoke<VaultStatus>('vault_status')) ?? { exists: false, unlocked: false };
  }

  /** Creates a new, empty vault protected by `masterPassword`. */
  async vaultCreate(masterPassword: string): Promise<void> {
    await this.invoke('vault_create', { masterPassword });
  }

  /** Decrypts the vault into memory; throws if the password is wrong. */
  async vaultUnlock(masterPassword: string): Promise<void> {
    await this.invoke('vault_unlock', { masterPassword });
  }

  /** Drops the decrypted entries from memory. The file on disk is untouched. */
  async vaultLock(): Promise<void> {
    await this.invoke('vault_lock');
  }

  /** Generates a password from the given character-class options. */
  async generatePassword(options: PasswordOptions): Promise<string> {
    return (await this.invoke<string>('generate_password', { options })) ?? '';
  }

  /** Adds a new entry to the unlocked vault and persists it immediately. */
  async vaultAddEntry(entry: NewVaultEntry): Promise<VaultEntrySummary | null> {
    return this.invoke<VaultEntrySummary>('vault_add_entry', { entry });
  }

  /** Lists every entry in the unlocked vault, without passwords. */
  async vaultListEntries(): Promise<readonly VaultEntrySummary[]> {
    return (await this.invoke<VaultEntrySummary[]>('vault_list_entries')) ?? [];
  }

  /** Reveals one entry's password by id. */
  async vaultRevealPassword(id: string): Promise<string> {
    return (await this.invoke<string>('vault_reveal_password', { id })) ?? '';
  }

  /** Removes an entry from the unlocked vault and persists the change. */
  async vaultDeleteEntry(id: string): Promise<void> {
    await this.invoke('vault_delete_entry', { id });
  }

  /** Writes an encrypted copy of the vault to disk and returns the path. */
  async vaultExport(): Promise<string> {
    return (await this.invoke<string>('vault_export')) ?? '';
  }

  async openCloudStatus(): Promise<OpenCloudStatus> {
    return (
      (await this.invoke<OpenCloudStatus>('opencloud_status')) ?? {
        connected: false,
        webdavUrl: null,
        username: null,
      }
    );
  }

  async openCloudConnect(webdavUrl: string, username: string, appToken: string): Promise<void> {
    await this.invoke('opencloud_connect', { webdavUrl, username, appToken });
  }

  async openCloudDisconnect(): Promise<void> {
    await this.invoke('opencloud_disconnect');
  }

  async openCloudList(path: string): Promise<readonly OpenCloudItem[]> {
    return (await this.invoke<OpenCloudItem[]>('opencloud_list', { path })) ?? [];
  }

  async openCloudCreateFolder(path: string, name: string): Promise<void> {
    await this.invoke('opencloud_create_folder', { path, name });
  }

  async openCloudUpload(
    path: string,
    name: string,
    mediaType: string,
    contentBase64: string,
  ): Promise<void> {
    await this.invoke('opencloud_upload', { path, name, mediaType, contentBase64 });
  }

  async openCloudDelete(path: string): Promise<void> {
    await this.invoke('opencloud_delete', { path });
  }

  async openCloudDownload(path: string): Promise<string> {
    return (await this.invoke<string>('opencloud_download', { path })) ?? '';
  }

  /** Whether a GitHub account is connected. Only reads the keychain. */
  async githubStatus(): Promise<GithubStatus> {
    return (
      (await this.invoke<GithubStatus>('github_status')) ?? {
        connected: false,
        username: null,
        nexusCredentialReady: false,
        nexusCredentialPending: false,
      }
    );
  }

  /**
   * Starts a Device Flow login and returns the code to show the user. The
   * wait for their approval continues in a background job — `jobId` lets the
   * caller correlate `notificationDone` for that job with this attempt.
   */
  async githubConnectStart(): Promise<DeviceAuthorization | null> {
    return this.invoke<DeviceAuthorization>('github_connect_start');
  }

  /** Removes the GitHub token and its registered webhooks. */
  async githubDisconnect(): Promise<void> {
    await this.invoke('github_disconnect');
  }

  async linearStatus(): Promise<readonly LinearConnection[]> {
    return (await this.invoke<LinearConnection[]>('linear_status')) ?? [];
  }

  async linearOauthConfigured(): Promise<boolean> {
    return (await this.invoke<boolean>('linear_oauth_configured')) ?? false;
  }

  async linearConnectStart(): Promise<void> {
    await this.invoke('linear_connect_start');
  }

  async linearDisconnect(organizationId: string): Promise<void> {
    await this.invoke('linear_disconnect', { organizationId });
  }

  async linearSyncConnection(organizationId: string): Promise<LinearConnection> {
    const connection = await this.invoke<LinearConnection>('linear_sync_connection', {
      organizationId,
    });
    if (!connection) throw new Error('Linear connection was not synced through Nexus.');
    return connection;
  }

  async linearTeams(organizationId: string): Promise<readonly LinearTeam[]> {
    return (await this.invoke<LinearTeam[]>('linear_teams', { organizationId })) ?? [];
  }

  async linearUsers(organizationId: string): Promise<readonly LinearPerson[]> {
    return (await this.invoke<LinearPerson[]>('linear_users', { organizationId })) ?? [];
  }

  async linearIssueLabels(organizationId: string): Promise<readonly LinearLabel[]> {
    return (await this.invoke<LinearLabel[]>('linear_issue_labels', { organizationId })) ?? [];
  }

  async linearProjects(
    organizationId: string,
    includeArchived = false,
  ): Promise<readonly LinearProject[]> {
    return (
      (await this.invoke<LinearProject[]>('linear_projects', {
        organizationId,
        includeArchived,
      })) ?? []
    );
  }

  async linearArchiveProject(organizationId: string, projectId: string): Promise<void> {
    await this.invoke('linear_archive_project', { organizationId, projectId });
  }

  async linearUnarchiveProject(organizationId: string, projectId: string): Promise<void> {
    await this.invoke('linear_unarchive_project', { organizationId, projectId });
  }

  async linearProjectStatuses(organizationId: string): Promise<readonly LinearProjectStatus[]> {
    return (
      (await this.invoke<LinearProjectStatus[]>('linear_project_statuses', { organizationId })) ??
      []
    );
  }

  async linearCreateProject(
    organizationId: string,
    teamId: string,
    name: string,
    description: string,
    startDate: string,
    targetDate: string,
    statusId: string,
    leadId: string,
  ): Promise<LinearProject> {
    const project = await this.invoke<LinearProject>('linear_create_project', {
      organizationId,
      teamId,
      name,
      description: description || null,
      startDate: startDate || null,
      targetDate: targetDate || null,
      statusId: statusId || null,
      leadId: leadId || null,
    });
    if (!project) throw new Error('Linear returned no project.');
    return project;
  }

  async linearUpdateProject(
    organizationId: string,
    projectId: string,
    name: string,
    description: string,
    startDate: string,
    targetDate: string,
    statusId: string,
    leadId: string,
    clearLead: boolean,
  ): Promise<LinearProject> {
    const project = await this.invoke<LinearProject>('linear_update_project', {
      organizationId,
      projectId,
      name,
      description,
      startDate: startDate || null,
      targetDate: targetDate || null,
      statusId: statusId || null,
      leadId: leadId || null,
      clearLead,
    });
    if (!project) throw new Error('Linear returned no project.');
    return project;
  }

  async linearProjectMilestones(
    organizationId: string,
    projectId: string,
  ): Promise<readonly LinearMilestone[]> {
    return (
      (await this.invoke<LinearMilestone[]>('linear_project_milestones', {
        organizationId,
        projectId,
      })) ?? []
    );
  }

  async linearProjectUpdates(
    organizationId: string,
    projectId: string,
    includeArchived = false,
  ): Promise<readonly LinearProjectUpdate[]> {
    return (
      (await this.invoke<LinearProjectUpdate[]>('linear_project_updates', {
        organizationId,
        projectId,
        includeArchived,
      })) ?? []
    );
  }

  async linearArchiveProjectUpdate(organizationId: string, updateId: string): Promise<void> {
    await this.invoke('linear_archive_project_update', { organizationId, updateId });
  }

  async linearUnarchiveProjectUpdate(organizationId: string, updateId: string): Promise<void> {
    await this.invoke('linear_unarchive_project_update', { organizationId, updateId });
  }

  async linearCreateProjectUpdate(
    organizationId: string,
    projectId: string,
    body: string,
    health: LinearProjectHealth,
  ): Promise<LinearProjectUpdate> {
    const update = await this.invoke<LinearProjectUpdate>('linear_create_project_update', {
      organizationId,
      projectId,
      body,
      health,
    });
    if (!update) throw new Error('Linear returned no project update.');
    return update;
  }

  async linearUpdateProjectUpdate(
    organizationId: string,
    updateId: string,
    body: string,
    health: LinearProjectHealth,
  ): Promise<LinearProjectUpdate> {
    const update = await this.invoke<LinearProjectUpdate>('linear_update_project_update', {
      organizationId,
      updateId,
      body,
      health,
    });
    if (!update) throw new Error('Linear returned no updated project update.');
    return update;
  }

  async linearCreateMilestone(
    organizationId: string,
    projectId: string,
    name: string,
    description: string,
    targetDate: string,
  ): Promise<LinearMilestone> {
    const milestone = await this.invoke<LinearMilestone>('linear_create_milestone', {
      organizationId,
      projectId,
      name,
      description: description || null,
      targetDate: targetDate || null,
    });
    if (!milestone) throw new Error('Linear returned no milestone.');
    return milestone;
  }

  async linearUpdateMilestone(
    organizationId: string,
    milestoneId: string,
    name: string,
    description: string,
    targetDate: string,
  ): Promise<LinearMilestone> {
    const milestone = await this.invoke<LinearMilestone>('linear_update_milestone', {
      organizationId,
      milestoneId,
      name,
      description,
      targetDate: targetDate || null,
    });
    if (!milestone) throw new Error('Linear returned no milestone.');
    return milestone;
  }

  async linearInitiatives(
    organizationId: string,
    includeArchived = false,
  ): Promise<readonly LinearInitiative[]> {
    return (
      (await this.invoke<LinearInitiative[]>('linear_initiatives', {
        organizationId,
        includeArchived,
      })) ?? []
    );
  }

  async linearArchiveInitiative(organizationId: string, initiativeId: string): Promise<void> {
    await this.invoke('linear_archive_initiative', { organizationId, initiativeId });
  }

  async linearUnarchiveInitiative(organizationId: string, initiativeId: string): Promise<void> {
    await this.invoke('linear_unarchive_initiative', { organizationId, initiativeId });
  }

  async linearCreateInitiative(
    organizationId: string,
    name: string,
    description: string,
    targetDate: string,
  ): Promise<LinearInitiative> {
    const initiative = await this.invoke<LinearInitiative>('linear_create_initiative', {
      organizationId,
      name,
      description: description || null,
      targetDate: targetDate || null,
    });
    if (!initiative) throw new Error('Linear returned no initiative.');
    return initiative;
  }

  async linearUpdateInitiative(
    organizationId: string,
    initiativeId: string,
    name: string,
    description: string,
    targetDate: string,
  ): Promise<LinearInitiative> {
    const initiative = await this.invoke<LinearInitiative>('linear_update_initiative', {
      organizationId,
      initiativeId,
      name,
      description,
      targetDate: targetDate || null,
    });
    if (!initiative) throw new Error('Linear returned no initiative.');
    return initiative;
  }

  async linearAddProjectToInitiative(
    organizationId: string,
    initiativeId: string,
    projectId: string,
  ): Promise<LinearInitiativeProject> {
    const link = await this.invoke<LinearInitiativeProject>('linear_add_project_to_initiative', {
      organizationId,
      initiativeId,
      projectId,
    });
    if (!link) throw new Error('Linear returned no project link.');
    return link;
  }

  async linearRemoveProjectFromInitiative(organizationId: string, linkId: string): Promise<void> {
    await this.invoke('linear_remove_project_from_initiative', { organizationId, linkId });
  }

  async linearCycles(organizationId: string, teamId: string): Promise<readonly LinearCycle[]> {
    return (await this.invoke<LinearCycle[]>('linear_cycles', { organizationId, teamId })) ?? [];
  }

  async linearCreateCycle(
    organizationId: string,
    teamId: string,
    name: string,
    startsAt: string,
    endsAt: string,
  ): Promise<LinearCycle> {
    const cycle = await this.invoke<LinearCycle>('linear_create_cycle', {
      organizationId,
      teamId,
      name: name || null,
      startsAt,
      endsAt,
    });
    if (!cycle) throw new Error('Linear returned no cycle.');
    return cycle;
  }

  async linearUpdateCycle(
    organizationId: string,
    cycleId: string,
    name: string,
    description: string,
    startsAt: string | null,
    endsAt: string | null,
  ): Promise<LinearCycle> {
    const cycle = await this.invoke<LinearCycle>('linear_update_cycle', {
      organizationId,
      cycleId,
      name,
      description,
      startsAt,
      endsAt,
    });
    if (!cycle) throw new Error('Linear returned no cycle.');
    return cycle;
  }

  async linearWorkflowStates(
    organizationId: string,
    teamId: string,
  ): Promise<readonly LinearWorkflowState[]> {
    return (
      (await this.invoke<LinearWorkflowState[]>('linear_workflow_states', {
        organizationId,
        teamId,
      })) ?? []
    );
  }

  async linearCreateIssue(
    organizationId: string,
    teamId: string,
    title: string,
    description: string,
    projectId: string | null = null,
    projectMilestoneId: string | null = null,
    parentId: string | null = null,
    estimate?: number,
  ): Promise<LinearIssue> {
    const issue = await this.invoke<LinearIssue>('linear_create_issue', {
      organizationId,
      teamId,
      title,
      description: description || null,
      projectId,
      projectMilestoneId,
      parentId,
      estimate,
    });
    if (!issue) throw new Error('Linear returned no issue.');
    return issue;
  }

  async linearIssueDetail(organizationId: string, issueId: string): Promise<LinearIssueDetail> {
    const detail = await this.invoke<LinearIssueDetail>('linear_issue_detail', {
      organizationId,
      issueId,
    });
    if (!detail) throw new Error('Linear returned no issue detail.');
    return detail;
  }

  async linearCreateComment(
    organizationId: string,
    issueId: string,
    body: string,
  ): Promise<LinearComment> {
    const comment = await this.invoke<LinearComment>('linear_create_comment', {
      organizationId,
      issueId,
      body,
    });
    if (!comment) throw new Error('Linear returned no comment.');
    return comment;
  }

  async linearCodexContext(organizationId: string, issueId = ''): Promise<LinearCodexContext> {
    const context = await this.invoke<LinearCodexContext>('linear_codex_context', {
      organizationId,
      issueId,
    });
    if (!context) throw new Error('Linear returned no Codex link context.');
    return context;
  }

  async linearSetCodexProjectAllowed(
    organizationId: string,
    projectId: string,
    allowed: boolean,
    workspaceRepo: string | null,
  ): Promise<void> {
    await this.invoke('linear_set_codex_project_allowed', {
      organizationId,
      projectId,
      allowed,
      workspaceRepo,
    });
  }

  async linearSaveCodexLink(
    organizationId: string,
    issueId: string,
    workspaceRepo: string,
    workspaceName: string,
    threadId: string,
  ): Promise<void> {
    await this.invoke('linear_save_codex_link', {
      organizationId,
      issueId,
      workspaceRepo,
      workspaceName,
      threadId,
    });
  }

  async linearUpdateIssue(
    organizationId: string,
    issueId: string,
    update: {
      title?: string;
      description?: string;
      projectId?: string;
      clearProject?: boolean;
      projectMilestoneId?: string;
      clearProjectMilestone?: boolean;
      dueDate?: string;
      clearDueDate?: boolean;
      estimate?: number;
      clearEstimate?: boolean;
      stateId?: string;
      assigneeId?: string;
      clearAssignee?: boolean;
      cycleId?: string;
      clearCycle?: boolean;
      priority?: number;
      labelIds?: readonly string[];
    },
  ): Promise<LinearIssue> {
    const issue = await this.invoke<LinearIssue>('linear_update_issue', {
      organizationId,
      issueId,
      ...update,
    });
    if (!issue) throw new Error('Linear returned no issue.');
    return issue;
  }

  async linearMyIssues(
    organizationId: string,
    after: string | null = null,
  ): Promise<LinearIssuePage> {
    const result = await this.invoke<LinearIssuePage>('linear_my_issues', {
      organizationId,
      after,
    });
    if (!result) throw new Error('Linear returned no issues.');
    return result;
  }

  async linearTeamIssues(
    organizationId: string,
    teamId: string,
    after: string | null = null,
  ): Promise<LinearIssuePage> {
    const result = await this.invoke<LinearIssuePage>('linear_team_issues', {
      organizationId,
      teamId,
      after,
    });
    if (!result) throw new Error('Linear returned no team issues.');
    return result;
  }

  async linearProjectIssues(
    organizationId: string,
    projectId: string,
    after: string | null = null,
  ): Promise<LinearIssuePage> {
    const result = await this.invoke<LinearIssuePage>('linear_project_issues', {
      organizationId,
      projectId,
      after,
    });
    if (!result) throw new Error('Linear returned no project issues.');
    return result;
  }

  async onLinearAuth(handler: (event: LinearAuthEvent) => void): Promise<() => void> {
    if (!this.available) return () => undefined;
    const { listen } = await import('@tauri-apps/api/event');
    return listen<LinearAuthEvent>('linear://auth', (message) => handler(message.payload));
  }

  async nexusAuthStatus(): Promise<NexusAuthStatus> {
    return (
      (await this.invoke<NexusAuthStatus>('nexus_auth_status')) ?? {
        connected: false,
        mfaRequired: false,
        userId: null,
        email: null,
        displayName: null,
      }
    );
  }

  async nexusAuthStart(): Promise<void> {
    await this.invoke('nexus_auth_start');
  }

  async nexusAuthLogin(email: string, password: string): Promise<NexusAuthLoginResult> {
    const result = await this.invoke<NexusAuthLoginResult>('nexus_auth_login', { email, password });
    if (!result) throw new Error('Nexus returned no sign-in result.');
    return result;
  }

  async nexusAuthRegister(email: string, password: string, displayName: string): Promise<void> {
    await this.invoke('nexus_auth_register', { email, password, displayName });
  }

  async nexusAuthVerifyEmail(token: string): Promise<void> {
    await this.invoke('nexus_auth_verify_email', { token });
  }

  async nexusAuthVerifyMfa(code: string, recoveryCode = ''): Promise<void> {
    await this.invoke('nexus_auth_verify_mfa', { code, recoveryCode });
  }

  async nexusAuthGoogleStart(): Promise<void> {
    await this.invoke('nexus_auth_google_start');
  }

  async nexusAuthLogout(): Promise<void> {
    await this.invoke('nexus_auth_logout');
  }

  async onNexusAuth(handler: (status: NexusAuthStatus) => void): Promise<() => void> {
    if (!this.available) return () => undefined;
    const { listen } = await import('@tauri-apps/api/event');
    return listen<NexusAuthStatus>('nexus://auth', (message) => handler(message.payload));
  }

  /**
   * Reads the connector's settings from `settings.json`. Merged field by
   * field against the defaults rather than returned as-is: `getSetting`
   * hands back whatever is on disk with no validation, and a value saved
   * under an older shape of `GithubConnectorSettings` (or one hand-edited
   * to drop a field) would otherwise reach callers with `notifications` —
   * or one kind within it — simply missing.
   */
  async githubSettings(): Promise<GithubConnectorSettings> {
    const stored = await this.getSetting<Partial<GithubConnectorSettings> | null>(
      'github.settings',
      null,
    );
    return mergeGithubSettings(stored);
  }

  /** Persists the connector's rules to `settings.json`. */
  async setGithubSettings(settings: GithubConnectorSettings): Promise<void> {
    await this.setSetting('github.settings', settings);
  }

  private async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T | null> {
    if (!this.available) {
      console.info(`[relay] invoke(${command}) skipped — not running under Tauri`, args);
      return null;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
  }
}

/** Mirrors src-tauri/src/commands.rs's `CoreCommand`. */
export type CoreCommand =
  | { readonly id: 'open_settings' }
  | { readonly id: 'open_main' }
  | { readonly id: 'hide_hud' }
  | { readonly id: 'open_vault' }
  | { readonly id: 'open_github' }
  | { readonly id: 'open_linear' }
  | { readonly id: 'open_runtime' }
  | { readonly id: 'open_agents' }
  | { readonly id: 'open_agent_thread'; readonly args: { readonly threadId: string } }
  | { readonly id: 'quit' };

export interface CodexThreadDetails {
  readonly thread: CodexThread;
  readonly olderCursor: string | null;
}

export interface CodexTurnPage {
  readonly turns: readonly CodexTurn[];
  readonly nextCursor: string | null;
}

/** Non-secret Grafana connection details. The API token lives in the OS keychain. */
export interface RuntimeGrafanaSettings {
  readonly grafanaUrl: string;
  readonly dashboardUrl: string;
}

export interface RuntimeGrafanaCheck {
  readonly version: string | null;
  readonly checkedAt: number;
  readonly dashboards: readonly RuntimeGrafanaDashboard[];
  readonly dashboardError: string | null;
}

export interface RuntimeGrafanaDashboard {
  readonly uid: string;
  readonly title: string;
  readonly url: string;
}

export interface RuntimeGrafanaPanel {
  readonly id: number | null;
  readonly title: string;
  readonly kind: string;
  readonly datasourceType: string | null;
  readonly datasourceUid: string | null;
  readonly targetCount: number;
}

export interface RuntimeGrafanaPanelInventory {
  readonly panels: readonly RuntimeGrafanaPanel[];
  readonly truncated: boolean;
}

export interface LeafHealthObservation {
  readonly checkedAt: number;
  readonly serverTime: string | null;
  readonly statusCode: number;
  readonly responseHeadersMs: number;
  readonly healthy: boolean;
}

export interface NexusReadinessObservation {
  readonly checkedAt: number;
  readonly statusCode: number;
  readonly responseHeadersMs: number;
  readonly ready: boolean;
}

export interface RuntimeStatusSnapshot {
  readonly leaf: LeafHealthObservation | null;
  readonly nexus: NexusReadinessObservation | null;
}

export interface RuntimeSignalEvent {
  readonly id: number;
  readonly source: 'leaf' | 'nexus';
  readonly state: 'reachable' | 'ready' | 'not-ready' | 'stale' | 'unknown';
  readonly previousState: RuntimeSignalEvent['state'] | null;
  readonly observedAt: number;
  readonly statusCode: number | null;
  readonly responseHeadersMs: number | null;
}

/** What the palette displays for a core-contributed row. Mirrors `CoreCommandMeta`. */
export interface CoreCommandMeta {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  readonly icon?: string;
}

/** Mirrors `vault::VaultStatus`. */
export interface VaultStatus {
  readonly exists: boolean;
  readonly unlocked: boolean;
}

export interface MobileUpdate {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly apkUrl: string;
  readonly releaseUrl: string;
}

export interface OpenCloudStatus {
  readonly connected: boolean;
  readonly webdavUrl: string | null;
  readonly username: string | null;
}

export interface OpenCloudItem {
  readonly path: string;
  readonly name: string;
  readonly isFolder: boolean;
  readonly size: number;
  readonly modified: string | null;
  readonly mediaType: string | null;
}

/** A local Git clone discovered by the bounded workspace scanner. */
export interface WorkspaceSummary {
  readonly name: string;
  readonly path: string;
  readonly githubRepo: string | null;
  readonly modifiedAt: number | null;
  readonly currentBranch?: string | null;
  readonly branches?: readonly string[];
  readonly packageScripts?: readonly string[];
}

export interface CodexRun {
  readonly threadId: string;
  readonly response: string;
}

export interface CodexThreadSummary {
  readonly id: string;
  readonly name: string | null;
  readonly preview: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recencyAt: number | null;
  readonly model: string | null;
  readonly gitInfo?: { readonly branch: string | null; readonly originUrl: string | null } | null;
  readonly status?: {
    readonly type: 'notLoaded' | 'idle' | 'active' | 'systemError';
    readonly activeFlags?: readonly ('waitingOnApproval' | 'waitingOnUserInput')[];
  };
}

export interface CodexThreadPage {
  readonly threads: readonly CodexThreadSummary[];
  readonly nextCursor: string | null;
}

export interface CodexThread extends CodexThreadSummary {
  readonly turns: readonly CodexTurn[];
}

export function codexThreadTitle(thread: Pick<CodexThreadSummary, 'name' | 'preview'>): string {
  return (
    (thread.name ? stripThreadMarkup(thread.name).trim() : '') ||
    codexThreadPreview(thread.preview) ||
    'Untitled Codex thread'
  );
}

export function codexThreadPreview(preview: string): string {
  return stripThreadMarkup(preview)
    .split(/## My request:\s*/i)
    .at(-1)!
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripThreadMarkup(value: string): string {
  return value
    .replace(
      /<(in-app-browser-context|environment_context|app-context|skills_instructions|heartbeat)\b[^>]*>[\s\S]*?(<\/\1\s*>|$)/gi,
      '',
    )
    .replace(/&lt;\/?[a-z][^&]*?&gt;/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, '');
}

export interface CodexTurn {
  readonly id: string;
  readonly status: string;
  readonly items: readonly CodexThreadItem[];
}

export interface CodexThreadItem {
  readonly id?: string;
  readonly type: string;
  readonly [field: string]: unknown;
}

export type ProjectActionRequest =
  | { readonly id: 'gitFetch' }
  | { readonly id: 'gitPull' }
  | { readonly id: 'gitSwitch'; readonly branch: string }
  | { readonly id: 'runScript'; readonly script: string };

/** Mirrors the Rust GitHub repository summary. Size is GitHub's KB value. */
export interface GithubRepositorySummary {
  readonly name: string;
  readonly fullName: string;
  readonly htmlUrl: string;
  readonly private: boolean;
  readonly visibility: string;
  readonly sizeKb: number;
  readonly pushedAt: string | null;
  readonly defaultBranch: string;
}

/** Mirrors the latest PR snapshot refreshed by GitHub webhook deliveries. */
export interface GithubPullRequestSummary {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly reviewRequested: boolean;
  readonly ciState: 'pending' | 'success' | 'failure' | null;
  readonly lastSeen: number;
  readonly headBranch?: string | null;
  readonly merged?: boolean;
}

/** Mirrors `vault::VaultEntrySummary` — every field but the password. */
export interface VaultEntrySummary {
  readonly id: string;
  readonly label: string;
  readonly username: string;
  readonly url?: string;
  readonly notes?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Mirrors `vault::NewVaultEntry`. */
export interface NewVaultEntry {
  readonly label: string;
  readonly username: string;
  readonly password: string;
  readonly url?: string;
  readonly notes?: string;
}

/** Mirrors `vault::PasswordOptions`. */
export interface PasswordOptions {
  readonly length: number;
  readonly upper: boolean;
  readonly lower: boolean;
  readonly digits: boolean;
  readonly symbols: boolean;
}

/** Mirrors `github::GithubStatus`. */
export interface GithubStatus {
  readonly connected: boolean;
  readonly username: string | null;
  readonly nexusCredentialReady: boolean;
  readonly nexusCredentialPending: boolean;
}

export interface NexusAuthStatus {
  readonly connected: boolean;
  readonly mfaRequired?: boolean;
  readonly userId: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly error?: string | null;
}

export interface NexusAuthLoginResult {
  readonly mfaRequired: boolean;
}

export interface LinearConnection {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly urlKey: string;
  readonly viewerId: string;
  readonly viewerName: string;
  readonly viewerEmail: string;
  readonly nexusCredentialId?: string;
}

export interface LinearTeam {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly timezone?: string | null;
  readonly issueEstimationType?: string;
  readonly issueEstimationExtended?: boolean;
  readonly issueEstimationAllowZero?: boolean;
}

export interface LinearPerson {
  readonly id: string;
  readonly name: string;
}

export interface LinearLabel {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly team?: { readonly id: string } | null;
}

export interface LinearProject {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly url: string;
  readonly startDate: string | null;
  readonly targetDate: string | null;
  readonly archivedAt: string | null;
  readonly status: LinearProjectStatus | null;
  readonly lead: LinearPerson | null;
}

export interface LinearProjectStatus {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

export interface LinearMilestone {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly targetDate: string | null;
}

export type LinearProjectHealth = 'onTrack' | 'atRisk' | 'offTrack';

export interface LinearProjectUpdate {
  readonly id: string;
  readonly body: string;
  readonly health: LinearProjectHealth;
  readonly createdAt: string;
  readonly user: LinearPerson;
  readonly archivedAt: string | null;
}

export interface LinearInitiative {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly targetDate: string | null;
  readonly archivedAt: string | null;
  readonly projects: readonly LinearInitiativeProject[];
}

export interface LinearInitiativeProject {
  readonly id: string;
  readonly project: { readonly id: string; readonly name: string };
}

export interface LinearCycle {
  readonly id: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly number: number;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly isActive: boolean;
  readonly team: LinearTeam;
}

export interface LinearWorkflowState {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly team?: { readonly id: string } | null;
}

export interface LinearIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  readonly priority: number;
  readonly estimate?: number | null;
  readonly dueDate?: string | null;
  readonly updatedAt: string;
  readonly state: { readonly id: string; readonly name: string; readonly kind: string } | null;
  readonly assignee: { readonly id: string; readonly name: string } | null;
  readonly project: { readonly id: string; readonly name: string } | null;
  readonly projectMilestone?: { readonly id: string; readonly name: string } | null;
  readonly cycle: {
    readonly id: string;
    readonly name: string | null;
    readonly number: number;
  } | null;
  readonly labels: readonly LinearLabel[];
  readonly team: LinearTeam;
}

export interface LinearIssuePage {
  readonly issues: readonly LinearIssue[];
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
}

export interface LinearComment {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly user: { readonly id: string; readonly name: string } | null;
}

export interface LinearCodexLink {
  readonly issueId: string;
  readonly deviceId: string;
  readonly workspaceRepo: string;
  readonly workspaceName: string;
  readonly threadId: string;
}

export interface LinearCodexContext {
  readonly deviceId: string;
  readonly links: readonly LinearCodexLink[];
  readonly allowedProjects: readonly LinearCodexProjectPolicy[];
}

export interface LinearCodexProjectPolicy {
  readonly projectId: string;
  readonly allowed: boolean;
  readonly workspaceRepo: string | null;
  readonly updatedAt: number;
}

export interface LinearIssueDetail {
  readonly issue: LinearIssue;
  readonly children: readonly LinearIssue[];
  readonly comments: readonly LinearComment[];
}

export interface LinearAuthEvent {
  readonly connected: boolean;
  readonly connection: LinearConnection | null;
  readonly error: string | null;
}

/** Mirrors `github::oauth::DeviceAuthorization`. */
export interface DeviceAuthorization {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly jobId: string;
}

/** Mirrors `github::rules::PrEventKind`. */
export type PrEventKind =
  'opened' | 'closed' | 'merged' | 'review_requested' | 'ci_failed' | 'ci_passed';

/** All six, in the order the settings UI lists them. */
export const PR_EVENT_KINDS: readonly PrEventKind[] = [
  'opened',
  'closed',
  'merged',
  'review_requested',
  'ci_failed',
  'ci_passed',
];

/** Mirrors `github::rules::NotificationTypeRule`. */
export interface NotificationTypeRule {
  readonly enabled: boolean;
  readonly repoPattern: string;
  readonly branchInclude: readonly string[];
  readonly branchExclude: readonly string[];
}

/** Mirrors `github::rules::NotificationSettings` — one rule per `PrEventKind`. */
export interface NotificationSettings {
  readonly opened: NotificationTypeRule;
  readonly closed: NotificationTypeRule;
  readonly merged: NotificationTypeRule;
  readonly reviewRequested: NotificationTypeRule;
  readonly ciFailed: NotificationTypeRule;
  readonly ciPassed: NotificationTypeRule;
}

/** Reads the rule for one kind out of `NotificationSettings` — mirrors `NotificationSettings::rule_for`. */
export function ruleFor(
  notifications: NotificationSettings,
  kind: PrEventKind,
): NotificationTypeRule {
  switch (kind) {
    case 'opened':
      return notifications.opened;
    case 'closed':
      return notifications.closed;
    case 'merged':
      return notifications.merged;
    case 'review_requested':
      return notifications.reviewRequested;
    case 'ci_failed':
      return notifications.ciFailed;
    case 'ci_passed':
      return notifications.ciPassed;
  }
}

/** Mirrors `github::rules::GithubConnectorSettings`. */
export interface GithubConnectorSettings {
  readonly notifications: NotificationSettings;
  readonly muted: readonly string[];
  /** A GitHub OAuth App (Device Flow enabled) client id. `null` until configured. */
  readonly clientId: string | null;
}

const DISABLED_RULE: NotificationTypeRule = {
  enabled: false,
  repoPattern: '*',
  branchInclude: [],
  branchExclude: [],
};

function enabledRule(repoPattern: string): NotificationTypeRule {
  return { enabled: true, repoPattern, branchInclude: [], branchExclude: [] };
}

/** Mirrors `GithubConnectorSettings::default()` in `github::rules`. */
export const DEFAULT_GITHUB_SETTINGS: GithubConnectorSettings = {
  notifications: {
    opened: enabledRule('*'),
    closed: DISABLED_RULE,
    merged: enabledRule('*'),
    reviewRequested: enabledRule('*'),
    ciFailed: enabledRule('*'),
    ciPassed: DISABLED_RULE,
  },
  muted: [],
  clientId: null,
};

/**
 * Fills in whatever `stored` is missing from `DEFAULT_GITHUB_SETTINGS`, one
 * field at a time — including within `notifications`, per kind — rather
 * than falling back wholesale the moment anything is absent. `stored` is
 * untyped data from disk in all but name: it may be `null` (never saved),
 * an older shape of this type, or hand-edited with a field dropped.
 */
function mergeGithubSettings(
  stored: Partial<GithubConnectorSettings> | null | undefined,
): GithubConnectorSettings {
  const notifications = stored?.notifications;
  const defaults = DEFAULT_GITHUB_SETTINGS;
  return {
    muted: stored?.muted ?? defaults.muted,
    clientId: stored?.clientId ?? defaults.clientId,
    notifications: {
      opened: notifications?.opened ?? defaults.notifications.opened,
      closed: notifications?.closed ?? defaults.notifications.closed,
      merged: notifications?.merged ?? defaults.notifications.merged,
      reviewRequested: notifications?.reviewRequested ?? defaults.notifications.reviewRequested,
      ciFailed: notifications?.ciFailed ?? defaults.notifications.ciFailed,
      ciPassed: notifications?.ciPassed ?? defaults.notifications.ciPassed,
    },
  };
}

/** Mirrors `gmail::GmailStatus`. */
export interface GmailStatus {
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly accountEmail: string | null;
}

/** Mirrors `gmail::rules::RuleKind`, one enabled row of `GmailSettings.rules.custom`. */
export type RuleKind =
  | { readonly kind: 'fromContains'; readonly text: string }
  | { readonly kind: 'subjectContains'; readonly text: string }
  | { readonly kind: 'label'; readonly label: string };

/** Mirrors `gmail::rules::Rule`. */
export interface Rule {
  readonly id: string;
  readonly enabled: boolean;
  readonly kind: RuleKind['kind'];
  readonly text?: string;
  readonly label?: string;
}

/** Mirrors `gmail::rules::NotificationRules`. */
export interface NotificationRules {
  readonly notifyAll: boolean;
  readonly notifyImportant: boolean;
  readonly custom: readonly Rule[];
}

/** Mirrors `gmail::GmailSettings`. */
export interface GmailSettings {
  readonly rules: NotificationRules;
  readonly pollIntervalSecs: number;
}
