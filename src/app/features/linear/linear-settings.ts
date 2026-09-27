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
          [disabled]="pending() || !oauthConfigured() || !nexus.status().connected"
          (click)="connect()"
        >
          {{ pending() ? 'Opening Linear' : 'Connect workspace' }}
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
                connection.nexusCredentialId ? 'Available across devices' : 'Stored on this device'
              }}
            </span>
          </div>
          <umbra-button size="sm" variant="outline" (click)="disconnect(connection)">
            Disconnect
          </umbra-button>
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

  protected async disconnect(connection: LinearConnection): Promise<void> {
    try {
      await this.tauri.linearDisconnect(connection.organizationId);
      await this.refresh();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
      await this.refresh();
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
