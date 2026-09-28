import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  signal,
} from '@angular/core';

import { NexusAccount } from '@core/nexus-account';
import { TauriBridge, type LinearConnection } from '@core/tauri';
import { UmbraButtonComponent } from '@umbra/components/umbra-button/umbra-button.component';

@Component({
  selector: 'rl-linear-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UmbraButtonComponent],
  template: `
    <section class="connections" aria-labelledby="linear-connections-title">
      <header>
        <div>
          <h2 id="linear-connections-title">Linear workspaces</h2>
          <p>Connect once through Nexus to make your workspaces available across devices.</p>
        </div>
        <umbra-button
          size="sm"
          variant="outline"
          [disabled]="!pending() && (!oauthConfigured() || !nexus.status().connected)"
          (click)="pending() ? cancelAuth() : connect()"
        >
          {{ pending() ? 'Cancel sign-in' : 'Connect workspace' }}
        </umbra-button>
      </header>
      @if (!oauthConfigured()) {
        <p class="hint">OAuth setup is pending the Relay Linear app registration.</p>
      }
      @if (!nexus.status().connected) {
        <p class="hint">Sign in to Nexus before connecting Linear.</p>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @for (connection of connections(); track connection.organizationId) {
        <div class="connection">
          <div>
            <strong>{{ connection.organizationName }}</strong>
            <span>{{ connection.viewerName }}</span>
            <span class="hint">
              {{
                connection.pausedOnDevice
                  ? 'Paused on this device'
                  : connection.nexusCredentialId
                    ? 'Available across devices'
                    : 'Stored on this device'
              }}
            </span>
          </div>
          <div class="connection-actions">
            @if (connection.agentInstalled) {
              <span class="hint">
                Relay agent installed ·
                {{ connection.nexusCredentialId ? 'available across devices' : 'this device only' }}
              </span>
            } @else {
              <span class="hint"
                >Workspace admin approval required for the separate agent identity.</span
              >
              <umbra-button
                size="sm"
                variant="outline"
                [disabled]="pending() || !nexus.status().connected"
                (click)="installAgent(connection)"
              >
                {{ pending() ? 'Opening Linear' : 'Install Relay agent' }}
              </umbra-button>
            }
            <umbra-button
              size="sm"
              variant="outline"
              (click)="pause(connection, !connection.pausedOnDevice)"
            >
              {{ connection.pausedOnDevice ? 'Resume on this device' : 'Pause on this device' }}
            </umbra-button>
            @if (confirmDisconnectId() === connection.organizationId) {
              <span class="hint">Revoke Linear access on all devices?</span>
              <umbra-button
                size="sm"
                variant="destructive"
                [disabled]="disconnectingId() === connection.organizationId"
                (click)="disconnect(connection)"
              >
                {{
                  disconnectingId() === connection.organizationId
                    ? 'Disconnecting'
                    : 'Confirm disconnect'
                }}
              </umbra-button>
              <umbra-button size="sm" variant="link" (click)="confirmDisconnectId.set(null)">
                Cancel
              </umbra-button>
            } @else {
              <umbra-button
                size="sm"
                variant="outline"
                (click)="confirmDisconnectId.set(connection.organizationId)"
              >
                Disconnect everywhere
              </umbra-button>
            }
          </div>
        </div>
      } @empty {
        <p class="hint">No workspaces connected.</p>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
    }
    .connections {
      display: grid;
      gap: var(--space-4);
    }
    header,
    .connection {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-4);
    }
    h2,
    p {
      margin: 0;
    }
    header p,
    .hint,
    .connection span {
      color: var(--text-muted);
      font-size: var(--text-12);
    }
    header p {
      margin-top: var(--space-2);
    }
    .connection {
      padding: var(--space-4);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
    }
    .connection > div {
      display: grid;
      gap: var(--space-1);
    }
    .connection-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .error {
      color: var(--danger);
    }
  `,
})
export class LinearSettings {
  private readonly tauri = inject(TauriBridge);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly nexus = inject(NexusAccount);
  protected readonly connections = signal<readonly LinearConnection[]>([]);
  protected readonly oauthConfigured = signal(false);
  protected readonly pending = signal(false);
  protected readonly confirmDisconnectId = signal<string | null>(null);
  protected readonly disconnectingId = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.tauri.linearOauthConfigured().then((value) => this.oauthConfigured.set(value));
    effect(() => {
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

  protected async connect(): Promise<void> {
    this.error.set(null);
    this.pending.set(true);
    try {
      await this.tauri.linearConnectStart();
    } catch (error) {
      this.pending.set(false);
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected async cancelAuth(): Promise<void> {
    try {
      await this.tauri.linearConnectCancel();
      this.pending.set(false);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected async installAgent(connection: LinearConnection): Promise<void> {
    this.error.set(null);
    this.pending.set(true);
    try {
      await this.tauri.linearAgentInstallStart(connection.organizationId);
    } catch (error) {
      this.pending.set(false);
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected async disconnect(connection: LinearConnection): Promise<void> {
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

  protected async pause(connection: LinearConnection, paused: boolean): Promise<void> {
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
