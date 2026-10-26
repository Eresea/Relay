import { Fragment } from 'react';
import { Button } from '@/components/ui/button';
import { useController, useSignals } from '@/lib/signals';
import { DestroyRef } from '@/lib/signals';
import { inject } from '@/lib/inject';
import { signal } from '@/lib/signals';

import { NexusAccount } from '@/core/nexus-account';
import { TauriBridge, type LinearConnection } from '@/core/tauri';

import './linear-settings.css';

export class LinearSettingsState {
  private readonly tauri = inject(TauriBridge);
  readonly destroyRef = new DestroyRef();
  readonly nexus = inject(NexusAccount);
  readonly connections = signal<readonly LinearConnection[]>([]);
  readonly oauthConfigured = signal(false);
  readonly pending = signal(false);
  readonly syncingId = signal<string | null>(null);
  readonly confirmDisconnectId = signal<string | null>(null);
  readonly disconnectingId = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  constructor() {
    void this.tauri.linearOauthConfigured().then((value) => this.oauthConfigured.set(value));
    this.destroyRef.effect(() => {
      this.nexus.status();
      void this.refresh();
    });
    void this.tauri
      .onLinearAuth((event) => {
        this.pending.set(false);
        this.error.set(event.error);
        void this.refresh();
      })
      .then((unlisten) => this.destroyRef.onDestroy(unlisten));
  }

  async connect(): Promise<void> {
    this.error.set(null);
    this.pending.set(true);
    try {
      await this.tauri.linearConnectStart();
    } catch (error) {
      this.pending.set(false);
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  async cancelAuth(): Promise<void> {
    try {
      await this.tauri.linearConnectCancel();
      this.pending.set(false);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  async installAgent(connection: LinearConnection): Promise<void> {
    this.error.set(null);
    this.pending.set(true);
    try {
      await this.tauri.linearAgentInstallStart(connection.organizationId);
    } catch (error) {
      this.pending.set(false);
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  async sync(connection: LinearConnection): Promise<void> {
    if (this.syncingId() || !this.nexus.status().connected) return;
    this.error.set(null);
    this.syncingId.set(connection.organizationId);
    try {
      await this.tauri.linearSyncConnection(connection.organizationId);
      await this.refresh();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.syncingId.set(null);
    }
  }

  async disconnect(connection: LinearConnection): Promise<void> {
    if (this.confirmDisconnectId() !== connection.organizationId || this.disconnectingId()) {
      return;
    }
    this.disconnectingId.set(connection.organizationId);
    try {
      await this.tauri.linearDisconnect(connection.organizationId);
      this.confirmDisconnectId.set(null);
      await this.refresh();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
      await this.refresh();
    } finally {
      this.disconnectingId.set(null);
    }
  }

  async pause(connection: LinearConnection, paused: boolean): Promise<void> {
    try {
      await this.tauri.linearPauseOnDevice(connection.organizationId, paused);
      await this.refresh();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  private async refresh(): Promise<void> {
    try {
      this.connections.set(await this.tauri.linearStatus());
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }
}

export function LinearSettings() {
  useSignals();
  const s = useController(() => new LinearSettingsState());
  return (
    <div className="linear-settings">
      <section className="connections" aria-labelledby="linear-connections-title">
        <header>
          <div>
            <h2 id="linear-connections-title">Linear workspaces</h2>
            <p>Connect once through Nexus to make your workspaces available across devices.</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!s.pending() && (!s.oauthConfigured() || !s.nexus.status().connected)}
            onClick={() => {
              void (s.pending() ? s.cancelAuth() : s.connect());
            }}
          >
            {s.pending() ? 'Cancel sign-in' : 'Connect workspace'}
          </Button>
        </header>
        {!s.oauthConfigured() ? (
          <>
            <p className="hint">OAuth setup is pending the Relay Linear app registration.</p>
          </>
        ) : null}
        {!s.nexus.status().connected ? (
          <>
            <p className="hint">Sign in to Nexus before connecting Linear.</p>
          </>
        ) : null}
        {s.error() ? (
          <>
            <p className="error" role="alert">
              {s.error()}
            </p>
          </>
        ) : null}
        {s.connections().length === 0 ? (
          <>
            <p className="hint">No workspaces connected.</p>
          </>
        ) : (
          s.connections().map((connection) => {
            return (
              <Fragment key={connection.organizationId}>
                <div className="connection">
                  <div>
                    <strong>{connection.organizationName}</strong>
                    <span>{connection.viewerName}</span>
                    <span className="hint">
                      {connection.pausedOnDevice
                        ? 'Paused on this device'
                        : connection.nexusSyncPending
                          ? 'Needs sync through Nexus'
                          : connection.nexusCredentialId
                            ? 'Available across devices'
                            : 'Stored on this device'}
                    </span>
                  </div>
                  <div className="connection-actions">
                    {!connection.nexusCredentialId || connection.nexusSyncPending ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={s.syncingId() !== null || !s.nexus.status().connected}
                          onClick={() => {
                            void s.sync(connection);
                          }}
                        >
                          {s.syncingId() === connection.organizationId
                            ? 'Syncing'
                            : connection.nexusSyncPending
                              ? 'Retry Nexus sync'
                              : 'Sync through Nexus'}
                        </Button>
                      </>
                    ) : null}
                    {connection.agentInstalled ? (
                      <>
                        <span className="hint">
                          Relay agent installed ·
                          {connection.nexusSyncPending
                            ? 'needs Nexus sync'
                            : connection.nexusCredentialId
                              ? 'available across devices'
                              : 'this device only'}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="hint">
                          Workspace admin approval required for the separate agent identity.
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={s.pending() || !s.nexus.status().connected}
                          onClick={() => {
                            void s.installAgent(connection);
                          }}
                        >
                          {s.pending() ? 'Opening Linear' : 'Install Relay agent'}
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void s.pause(connection, !connection.pausedOnDevice);
                      }}
                    >
                      {connection.pausedOnDevice ? 'Resume on this device' : 'Pause on this device'}
                    </Button>
                    {s.confirmDisconnectId() === connection.organizationId ? (
                      <>
                        <span className="hint">Revoke Linear access on all devices?</span>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={s.disconnectingId() === connection.organizationId}
                          onClick={() => {
                            void s.disconnect(connection);
                          }}
                        >
                          {s.disconnectingId() === connection.organizationId
                            ? 'Disconnecting'
                            : 'Confirm disconnect'}
                        </Button>
                        <Button
                          size="sm"
                          variant="link"
                          onClick={() => {
                            void s.confirmDisconnectId.set(null);
                          }}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            void s.confirmDisconnectId.set(connection.organizationId);
                          }}
                        >
                          Disconnect everywhere
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </Fragment>
            );
          })
        )}
      </section>
    </div>
  );
}
