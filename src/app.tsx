import { lazy, Suspense, type ComponentType } from 'react';

import { CommandRegistry } from '@/core/command-registry';
import { registerDefaultCommands } from '@/core/default-commands';
import { ModuleRegistry } from '@/core/modules';
import { NotificationCenter } from '@/core/notification-center';
import { currentSurface, isOverlaySurface, type Surface } from '@/core/surface';
import { TauriBridge, type CoreCommand } from '@/core/tauri';
import { ThemeService } from '@/core/theme';
import { UpdateCenter } from '@/features/updates/update-center';
import { inject } from '@/lib/inject';

/**
 * Relay renders one of four surfaces from one bundle, depending on which
 * window asks (see core/surface.ts). Each loads lazily, so the palette's
 * webview never parses the main window's code.
 */
const SURFACES: Record<Surface, ComponentType> = {
  palette: lazy(() => import('@/features/palette/command-palette')),
  hud: lazy(() => import('@/features/hud/hud-surface')),
  main: lazy(() => import('@/features/home/home')),
  mobile: lazy(() => import('@/features/mobile/mobile')),
};

export const surface = currentSurface();

export function App() {
  const Surface = SURFACES[surface];
  return (
    <Suspense fallback={<main className="h-full" aria-busy="true" />}>
      <Surface />
    </Suspense>
  );
}

/**
 * Everything that must happen once per window, before React renders: the
 * theme, the overlay document class, the command floor, and the one
 * subscription to the core's event channel. Runs once, outside React.
 */
export function bootstrap(): void {
  // Constructing the theme service runs the effect that writes data-theme.
  inject(ThemeService);

  if (isOverlaySurface(surface)) document.documentElement.classList.add('overlay-window');

  registerDefaultCommands();

  if (surface === 'mobile') {
    void setupMobileNotifications().then(subscribeToEvents);
  } else {
    void mergeCoreCommands();
    void subscribeToEvents();
  }
}

/** Commands owned by the Rust side: system actions, service control. */
async function mergeCoreCommands(): Promise<void> {
  const tauri = inject(TauriBridge);
  const core = await tauri.coreCommands();
  if (core.length === 0) return;
  inject(CommandRegistry).register(
    ...core.map((c) => ({
      ...c,
      // c.id comes from the same Rust source as CoreCommand's ids (a Rust test
      // pairs them), but arrives as a plain string TypeScript cannot check.
      run: () => tauri.runCoreCommand({ id: c.id } as CoreCommand),
    })),
  );
}

/** Routes the core's push channel into whichever service owns that kind of event. */
async function subscribeToEvents(): Promise<void> {
  const tauri = inject(TauriBridge);
  const notifications = inject(NotificationCenter);
  const updates = inject(UpdateCenter);
  const modules = inject(ModuleRegistry);
  try {
    notifications.restore(await tauri.notificationsList());
    if (surface !== 'mobile') updates.restore(await tauri.updateStatus());
  } catch (error: unknown) {
    console.error('[relay] notification history unavailable', error);
  }
  await tauri.onEvent((event) => {
    notifications.handle(event);
    if (surface !== 'mobile') updates.handle(event);
    if (event.type === 'modulesChanged') void modules.load();
  });
}

interface MobileNotificationAction {
  readonly actionId?: string;
  readonly notification?: { readonly extra?: Record<string, unknown> };
}

async function setupMobileNotifications(): Promise<void> {
  const tauri = inject(TauriBridge);
  if (!tauri.available) return;

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

    await onAction((raw) => {
      const action = raw as unknown as MobileNotificationAction;
      const notificationId = action.notification?.extra?.['notificationId'];
      if (typeof notificationId !== 'string') return;

      if (action.actionId === 'clear') {
        inject(NotificationCenter).clearHistory();
        void tauri.notificationsClear();
        return;
      }

      void tauri.notificationsMarkRead([notificationId]);
      const openUrl = action.notification?.extra?.['openUrl'];
      if (
        (action.actionId === 'tap' || action.actionId === 'open') &&
        typeof openUrl === 'string'
      ) {
        void tauri.openUrl(openUrl);
      }
    });
  } catch (error: unknown) {
    console.error('[relay] mobile notifications unavailable', error);
  }
}
