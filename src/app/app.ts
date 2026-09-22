import { ChangeDetectionStrategy, Component, DestroyRef, inject } from '@angular/core';

import { CommandRegistry } from '@core/command-registry';
import { registerDefaultCommands } from '@core/default-commands';
import { NotificationCenter } from '@core/notification-center';
import { currentSurface, isOverlaySurface } from '@core/surface';
import { TauriBridge, type CoreCommand } from '@core/tauri';
import { UpdateCenter } from '@features/updates/update-center';
import { ThemeService } from '@core/theme';
import { CommandPalette } from '@features/palette/command-palette';
import { Home } from '@features/home/home';
import { HudSurface } from '@features/hud/hud-surface';
import { Mobile } from '@features/mobile/mobile';

/**
 * Relay renders one of three surfaces depending on which window is asking.
 * The overlay surfaces take the glass tier and a transparent document; the
 * main window is a flat, opaque app surface.
 */
@Component({
  selector: 'rl-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommandPalette, Home, HudSurface, Mobile],
  template: `
    @switch (surface) {
      @case ('palette') {
        <rl-command-palette />
      }
      @case ('hud') {
        <rl-hud-surface />
      }
      @case ('mobile') {
        <rl-mobile />
      }
      @default {
        <rl-home />
      }
    }
  `,
  styles: `
    :host {
      display: block;
      block-size: 100%;
    }
  `,
})
export class App {
  private readonly registry = inject(CommandRegistry);
  private readonly tauri = inject(TauriBridge);
  private readonly notifications = inject(NotificationCenter);
  private readonly updates = inject(UpdateCenter);

  protected readonly surface = currentSurface();

  constructor() {
    // Touch the theme service so the effect that writes data-theme runs.
    inject(ThemeService);

    if (isOverlaySurface(this.surface)) {
      document.documentElement.classList.add('overlay-window');
    }

    const dispose = registerDefaultCommands();
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(dispose);

    if (this.surface !== 'mobile') void this.mergeCoreCommands();
    if (this.surface === 'mobile') {
      void this.startMobileSurface(destroyRef);
    } else {
      void this.subscribeToEvents(destroyRef);
    }
  }

  private async startMobileSurface(destroyRef: DestroyRef): Promise<void> {
    await this.setupMobileNotifications(destroyRef);
    await this.subscribeToEvents(destroyRef);
  }

  private async setupMobileNotifications(destroyRef: DestroyRef): Promise<void> {
    if (!this.tauri.available) return;

    try {
      const {
        Importance,
        Visibility,
        createChannel,
        isPermissionGranted,
        onAction,
        registerActionTypes,
        requestPermission,
      } = await import('@tauri-apps/plugin-notification');

      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === 'granted';
      if (!granted) return;

      await createChannel({
        id: 'relay-events',
        name: 'Relay events',
        description: 'Notifications from Relay connectors and jobs.',
        importance: Importance.Default,
        visibility: Visibility.Private,
        vibration: true,
      });
      await registerActionTypes([
        {
          id: 'relay-notification',
          actions: [
            { id: 'open', title: 'Open' },
            { id: 'mark-read', title: 'Mark read' },
            { id: 'clear', title: 'Clear' },
          ],
        },
      ]);

      const listener = await onAction((raw) => {
        const action = raw as unknown as MobileNotificationAction;
        const notificationId = action.notification?.extra?.['notificationId'];
        if (typeof notificationId !== 'string') return;

        if (action.actionId === 'clear') {
          this.notifications.clearHistory();
          void this.tauri.notificationsClear();
          return;
        }

        void this.tauri.notificationsMarkRead([notificationId]);
        const openUrl = action.notification?.extra?.['openUrl'];
        if (
          (action.actionId === 'tap' || action.actionId === 'open') &&
          typeof openUrl === 'string'
        ) {
          void this.tauri.openUrl(openUrl);
        }
      });
      destroyRef.onDestroy(() => void listener.unregister());
    } catch (error: unknown) {
      console.error('[relay] mobile notifications unavailable', error);
    }
  }

  /** Commands owned by the Rust side — system actions, service control. */
  private async mergeCoreCommands(): Promise<void> {
    const core = await this.tauri.coreCommands();
    if (core.length > 0) {
      this.registry.register(
        ...core.map((c) => ({
          ...c,
          // c.id comes from the same Rust source as CoreCommand's ids
          // (core_commands.rs tests this pairing), but arrives here as a
          // plain string — TS cannot see that connection statically.
          run: () => this.tauri.runCoreCommand({ id: c.id } as CoreCommand),
        })),
      );
    }
  }

  /** Routes the core's push channel into whichever service owns that kind of event. */
  private async subscribeToEvents(destroyRef: DestroyRef): Promise<void> {
    try {
      this.notifications.restore(await this.tauri.notificationsList());
      if (this.surface !== 'mobile') this.updates.restore(await this.tauri.updateStatus());
    } catch (error: unknown) {
      console.error('[relay] notification history unavailable', error);
    }
    const unlisten = await this.tauri.onEvent((event) => {
      this.notifications.handle(event);
      if (this.surface !== 'mobile') this.updates.handle(event);
    });
    destroyRef.onDestroy(unlisten);
  }
}

interface MobileNotificationAction {
  readonly actionId?: string;
  readonly notification?: {
    readonly extra?: Record<string, unknown>;
  };
}
