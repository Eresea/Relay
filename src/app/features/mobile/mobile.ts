import { onBackButtonPress } from '@tauri-apps/api/app';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';

import type { Command, CommandMatch } from '@core/command';
import { search } from '@core/fuzzy';
import { NotificationCenter } from '@core/notification-center';
import type { NotificationRecord } from '@core/events';
import { ThemeService } from '@core/theme';
import { TauriBridge, type MobileUpdate, type VaultStatus } from '@core/tauri';
import { Settings } from '@features/settings/settings';
import { Vault } from '@features/vault/vault';
import { Icon } from '@shared/icon';
import { MobileConnections } from './mobile-connections';

type MobileTab = 'dashboard' | 'notifications' | 'vault' | 'connections' | 'settings';

interface MobileModule extends Command {
  readonly tab: MobileTab;
}

interface TitlePart {
  readonly text: string;
  readonly matched: boolean;
}

interface MobileModuleMatch extends Omit<CommandMatch, 'command'> {
  readonly command: MobileModule;
}

const MOBILE_MODULES: readonly MobileModule[] = [
  {
    id: 'mobile.dashboard',
    tab: 'dashboard',
    title: 'Dashboard',
    group: 'Modules',
    icon: 'house',
    keywords: ['home', 'overview'],
    run: () => undefined,
  },
  {
    id: 'mobile.notifications',
    tab: 'notifications',
    title: 'Notifications',
    group: 'Modules',
    icon: 'inbox',
    keywords: ['inbox', 'activity', 'alerts'],
    run: () => undefined,
  },
  {
    id: 'mobile.vault',
    tab: 'vault',
    title: 'Password vault',
    group: 'Modules',
    icon: 'lock',
    keywords: ['password', 'secret', 'account'],
    run: () => undefined,
  },
  {
    id: 'mobile.connections',
    tab: 'connections',
    title: 'Connections',
    group: 'Modules',
    icon: 'plus',
    keywords: ['connect', 'github', 'gmail'],
    run: () => undefined,
  },
  {
    id: 'mobile.settings',
    tab: 'settings',
    title: 'Settings',
    group: 'Modules',
    icon: 'settings',
    keywords: ['preferences', 'appearance'],
    run: () => undefined,
  },
];

@Component({
  selector: 'rl-mobile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, MobileConnections, Settings, Vault],
  template: `
    <div
      class="mobile-shell"
      tabindex="0"
      (keydown)="onShellKeydown($event)"
      (pointerdown)="startRailGesture($event)"
      (pointermove)="moveRailGesture($event)"
      (pointerup)="endRailGesture($event)"
      (pointercancel)="cancelRailGesture($event)"
    >
      <header class="mobile-header">
        <button
          type="button"
          class="header-button"
          (click)="toggleRail()"
          [attr.aria-expanded]="railOpen()"
          [attr.aria-label]="railOpen() ? 'Close navigation' : 'Open navigation'"
          aria-controls="mobile-rail"
        >
          <rl-icon name="panel-left" [size]="16" />
        </button>
        <div class="mobile-header-title">
          <p class="eyebrow">Relay</p>
          <h1 #pageTitle tabindex="-1">{{ tabTitle() }}</h1>
        </div>
        <div class="header-actions">
          <button
            type="button"
            class="header-button"
            (click)="openCommandMenu()"
            aria-label="Find a module"
          >
            <rl-icon name="search" [size]="16" />
          </button>
          <button
            type="button"
            class="header-button"
            (click)="theme.toggle()"
            [attr.aria-label]="
              theme.theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
            "
            [attr.title]="
              theme.theme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
            "
          >
            <rl-icon [name]="theme.theme() === 'dark' ? 'sun' : 'moon'" [size]="16" />
          </button>
        </div>
      </header>

      <button
        type="button"
        class="rail-backdrop"
        [class.open]="railOpen()"
        [class.dragging]="railGestureActive()"
        [style.opacity]="railProgress()"
        [attr.aria-hidden]="!railOpen()"
        [attr.inert]="railOpen() ? null : ''"
        (click)="closeRail()"
        aria-label="Close navigation"
      ></button>
      <aside
        id="mobile-rail"
        class="mobile-rail"
        [class.open]="railOpen()"
        [class.dragging]="railGestureActive()"
        [style.transform]="'translate3d(' + (railProgress() - 1) * 100 + '%, 0, 0)'"
        [attr.aria-hidden]="!railOpen()"
        [attr.inert]="railOpen() ? null : ''"
        aria-label="Relay navigation"
      >
        <div class="rail-heading">
          <span class="eyebrow">Go to</span>
          <button
            type="button"
            class="rail-close"
            (click)="closeRail()"
            aria-label="Close navigation"
          >
            <rl-icon name="x" [size]="16" />
          </button>
        </div>
        <label class="rail-search">
          <rl-icon name="search" [size]="16" />
          <input
            #moduleSearch
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="Find a module"
            aria-label="Find a module"
            role="combobox"
            aria-autocomplete="list"
            [value]="moduleQuery()"
            [attr.aria-expanded]="railOpen()"
            aria-controls="mobile-module-results"
            [attr.aria-activedescendant]="activeModule() ? 'mobile-' + activeModule()!.id : null"
            (input)="onModuleQuery($any($event.target).value)"
          />
        </label>
        <div id="mobile-module-results" class="rail-modules" role="listbox" aria-label="Modules">
          @for (match of moduleMatches(); track match.command.id) {
            @let module = match.command;
            @let index = moduleIndex(match);
            <button
              type="button"
              class="rail-item"
              role="option"
              [id]="'mobile-' + module.id"
              [attr.aria-label]="module.title"
              [class.active]="tab() === module.tab"
              [class.command-active]="index === activeModuleIndex()"
              [attr.aria-current]="tab() === module.tab ? 'page' : null"
              [attr.aria-selected]="index === activeModuleIndex()"
              (click)="selectModule(module)"
              (mousemove)="activeModuleIndex.set(index)"
            >
              <rl-icon [name]="module.icon ?? 'circle'" [size]="16" />
              <span class="module-label">
                @for (part of moduleTitleParts(match); track $index) {
                  @if (part.matched) {
                    <mark>{{ part.text }}</mark>
                  } @else {
                    {{ part.text }}
                  }
                }
              </span>
              @if (module.tab === 'notifications' && unreadCount() > 0) {
                <span class="rail-badge">{{ unreadCount() }}</span>
              }
            </button>
          } @empty {
            <p class="module-empty">No matching module</p>
          }
        </div>
      </aside>

      <main class="mobile-content">
        @if (tab() === 'dashboard') {
          <section class="welcome">
            <p class="eyebrow">Good to have you back</p>
            <p class="welcome-copy">The things worth checking, without the desktop overhead.</p>
          </section>

          <div class="summary-grid">
            <button type="button" class="summary-card" (click)="tab.set('notifications')">
              <span class="summary-icon"><rl-icon name="inbox" [size]="16" /></span>
              <span class="summary-value">{{ unreadCount() }}</span>
              <span class="summary-label">Unread notifications</span>
            </button>
            <button type="button" class="summary-card" (click)="tab.set('vault')">
              <span class="summary-icon"><rl-icon name="lock" [size]="16" /></span>
              <span class="summary-value">{{ vaultLabel() }}</span>
              <span class="summary-label">Password vault</span>
            </button>
            <button type="button" class="summary-card" (click)="selectTab('connections')">
              <span class="summary-icon"><rl-icon name="settings" [size]="16" /></span>
              <span class="summary-value">{{ connectionSummary() }}</span>
              <span class="summary-label">Connections</span>
            </button>
          </div>

          @if (mobileUpdate(); as update) {
            <section class="mobile-update">
              <div>
                <p class="eyebrow">Update available</p>
                <h2>Relay {{ update.latestVersion }}</h2>
                <p class="section-copy">A newer Android build is ready to install.</p>
              </div>
              <button
                type="button"
                class="text-button"
                [disabled]="updateBusy()"
                (click)="installUpdate(update)"
              >
                {{ updateBusy() ? 'Opening…' : 'Install' }}
              </button>
            </section>
          }

          <section class="section">
            <div class="section-heading">
              <h2>Recent activity</h2>
              <button type="button" class="text-button" (click)="tab.set('notifications')">
                See all
              </button>
            </div>
            @if (recentNotifications().length === 0) {
              <p class="empty-card">Nothing new yet.</p>
            } @else {
              <div class="activity-list">
                @for (notification of recentNotifications(); track notification.notificationId) {
                  <button
                    type="button"
                    class="activity-row"
                    [class.unread]="!notification.read"
                    (click)="openNotification(notification)"
                  >
                    <span class="status-dot" [attr.data-status]="notification.status"></span>
                    <span class="activity-copy">
                      <strong>{{ notification.title }}</strong>
                      <span>{{ notification.detail || 'Relay notification' }}</span>
                    </span>
                    <rl-icon name="chevron-right" [size]="16" />
                  </button>
                }
              </div>
            }
          </section>
        } @else if (tab() === 'notifications') {
          <section class="section full-section">
            <div class="section-heading">
              <div>
                <h2>Notifications</h2>
                <p class="section-copy">{{ unreadCount() }} unread</p>
              </div>
              <button
                type="button"
                class="text-button"
                [disabled]="notifications().length === 0"
                (click)="clearNotifications()"
              >
                Clear
              </button>
            </div>
            @if (notifications().length === 0) {
              <p class="empty-card">Nothing new.</p>
            } @else {
              <div class="activity-list">
                @for (notification of notifications(); track notification.notificationId) {
                  <div class="notification-swipe">
                    <span class="swipe-action" aria-hidden="true">Mark read</span>
                    <button
                      type="button"
                      class="activity-row"
                      [class.unread]="!notification.read"
                      [class.swiping]="isSwiping(notification.notificationId)"
                      [style.transform]="
                        'translateX(' + swipeOffset(notification.notificationId) + 'px)'
                      "
                      (pointerdown)="startNotificationSwipe($event, notification.notificationId)"
                      (pointermove)="moveNotificationSwipe($event)"
                      (pointerup)="endNotificationSwipe($event)"
                      (pointercancel)="cancelNotificationSwipe()"
                      (click)="openNotification(notification, $event)"
                    >
                      <span class="status-dot" [attr.data-status]="notification.status"></span>
                      <span class="activity-copy">
                        <strong>{{ notification.title }}</strong>
                        <span>{{ notification.detail || 'Relay notification' }}</span>
                      </span>
                      <rl-icon name="chevron-right" [size]="16" />
                    </button>
                  </div>
                }
              </div>
            }
          </section>
        } @else if (tab() === 'settings') {
          <rl-settings />
        } @else if (tab() === 'vault') {
          <section class="section full-section vault-section">
            <rl-vault />
          </section>
        } @else {
          <section class="section full-section connections-section">
            <rl-mobile-connections />
          </section>
        }
      </main>

      <nav class="mobile-nav" aria-label="Mobile navigation">
        <button
          type="button"
          [class.active]="tab() === 'dashboard'"
          (click)="selectTab('dashboard')"
          [attr.aria-current]="tab() === 'dashboard' ? 'page' : null"
          aria-label="Dashboard"
        >
          <rl-icon name="house" [size]="16" />
          <span>Home</span>
        </button>
        <button
          type="button"
          [class.active]="tab() === 'notifications'"
          (click)="selectTab('notifications')"
          [attr.aria-current]="tab() === 'notifications' ? 'page' : null"
          aria-label="Notifications"
        >
          <span class="nav-icon">
            <rl-icon name="inbox" [size]="16" />
            @if (unreadCount() > 0) {
              <span class="nav-badge">{{ unreadCount() }}</span>
            }
          </span>
          <span>Inbox</span>
        </button>
        <button
          type="button"
          [class.active]="tab() === 'vault'"
          (click)="selectTab('vault')"
          [attr.aria-current]="tab() === 'vault' ? 'page' : null"
          aria-label="Password vault"
        >
          <rl-icon name="lock" [size]="16" />
          <span>Vault</span>
        </button>
        <button
          type="button"
          [class.active]="tab() === 'connections'"
          (click)="selectTab('connections')"
          [attr.aria-current]="tab() === 'connections' ? 'page' : null"
        >
          <rl-icon name="plus" [size]="16" />
          <span>Connect</span>
        </button>
        <button
          type="button"
          [class.active]="tab() === 'settings'"
          (click)="selectTab('settings')"
          [attr.aria-current]="tab() === 'settings' ? 'page' : null"
        >
          <rl-icon name="settings" [size]="16" />
          <span>Settings</span>
        </button>
      </nav>
    </div>
  `,
  styles: `
    :host {
      display: block;
      block-size: 100%;
      color: var(--text-body);
      background: var(--bg-base);
    }

    .mobile-shell {
      position: relative;
      display: flex;
      flex-direction: column;
      block-size: 100%;
      min-block-size: 100dvh;
      max-inline-size: 720px;
      margin-inline: auto;
      overflow: hidden;
      touch-action: pan-y;
    }

    .mobile-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex: none;
      padding: calc(var(--space-5) + env(safe-area-inset-top)) var(--space-5) var(--space-4);
      background: var(--bg-sunken);
      border-block-end: 1px solid var(--border-subtle);
    }

    .eyebrow {
      margin: 0;
      color: var(--text-muted);
      font-size: var(--text-11);
      font-weight: var(--weight-semibold);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    h1,
    h2,
    p {
      margin: 0;
    }

    h1 {
      margin-block-start: var(--space-1);
      font-size: var(--text-20);
      letter-spacing: -0.04em;
    }

    h2 {
      font-size: var(--text-15);
      letter-spacing: -0.02em;
    }

    .header-button,
    .text-button,
    .mobile-nav button,
    .summary-card,
    .activity-row {
      -webkit-tap-highlight-color: transparent;
    }

    .header-button {
      display: grid;
      place-items: center;
      inline-size: 44px;
      block-size: 44px;
      color: var(--text-subtle);
      border-radius: var(--radius-md);
    }

    .header-button:hover,
    .header-button:focus-visible {
      color: var(--text-strong);
      background: var(--tint-hover);
    }

    .rail-backdrop {
      position: fixed;
      z-index: 4;
      inset: 0;
      background: color-mix(in srgb, var(--bg-app) 48%, transparent);
      opacity: 0;
      pointer-events: none;
      transition: opacity 220ms cubic-bezier(0.2, 0, 0, 1);
    }

    .rail-backdrop.open {
      pointer-events: auto;
    }

    .rail-backdrop.dragging {
      transition: none;
    }

    .mobile-rail {
      position: fixed;
      z-index: 5;
      inset-block: 0;
      inset-inline-start: 0;
      display: flex;
      inline-size: min(82vw, 288px);
      flex-direction: column;
      gap: var(--space-2);
      padding: calc(var(--space-5) + env(safe-area-inset-top)) var(--space-4)
        calc(var(--space-4) + env(safe-area-inset-bottom));
      background: var(--bg-sunken);
      border-inline-end: 1px solid var(--border-subtle);
      box-shadow: var(--shadow-lg);
      visibility: hidden;
      transition:
        transform 220ms cubic-bezier(0.2, 0, 0, 1),
        visibility 0s linear 220ms;
    }

    .mobile-rail.open,
    .mobile-rail.dragging {
      visibility: visible;
      transition: transform 220ms cubic-bezier(0.2, 0, 0, 1);
    }

    .mobile-rail.dragging {
      transition: none;
    }

    .rail-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-block-size: 44px;
      margin-block-end: var(--space-3);
    }

    .rail-close {
      display: grid;
      place-items: center;
      inline-size: 44px;
      block-size: 44px;
      color: var(--text-subtle);
      border-radius: var(--radius-md);
    }

    .rail-close:hover,
    .rail-close:focus-visible,
    .rail-item:hover,
    .rail-item:focus-visible,
    .rail-item.active {
      background: var(--tint-hover);
    }

    .rail-item {
      display: flex;
      align-items: center;
      min-block-size: 48px;
      gap: var(--space-3);
      padding-inline: var(--space-3);
      color: var(--text-subtle);
      border-radius: var(--radius-md);
      text-align: start;
    }

    .rail-item.active {
      color: var(--text-strong);
      background: var(--tint-selected);
    }

    .rail-settings {
      margin-block-start: auto;
      padding-block-start: var(--space-3);
      border-block-start: 1px solid var(--border-subtle);
    }

    .rail-badge {
      min-inline-size: 20px;
      margin-inline-start: auto;
      padding-inline: 5px;
      color: var(--primary-ink);
      background: var(--primary);
      border-radius: var(--radius-pill);
      font-size: var(--text-11);
      line-height: 20px;
      text-align: center;
    }

    .mobile-content {
      flex: 1;
      min-block-size: 0;
      overflow-y: auto;
      padding: var(--space-5);
      touch-action: pan-y;
    }

    .welcome {
      margin-block-end: var(--space-5);
    }

    .welcome-copy {
      max-inline-size: 32em;
      margin-block-start: var(--space-2);
      color: var(--text-muted);
      font-size: var(--text-14);
      line-height: 1.5;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: var(--space-3);
    }

    .summary-card,
    .empty-card,
    .activity-list {
      border: 1px solid var(--border-subtle);
      background: var(--bg-raised);
      border-radius: var(--radius-lg);
    }

    .summary-card {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      min-block-size: 136px;
      padding: var(--space-4);
      color: var(--text-body);
      text-align: start;
    }

    .summary-card:hover,
    .summary-card:focus-visible {
      border-color: var(--border-strong);
    }

    .mobile-update {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      margin-block-start: var(--space-4);
      padding: var(--space-4);
      border: 1px solid var(--primary);
      background: var(--tint-selected);
      border-radius: var(--radius-lg);
    }

    .mobile-update h2 {
      margin-block-start: var(--space-1);
    }

    .summary-icon {
      display: grid;
      place-items: center;
      inline-size: 36px;
      block-size: 36px;
      margin-block-end: var(--space-4);
      color: var(--accent);
      background: var(--tint-selected);
      border-radius: var(--radius-md);
    }

    .summary-value {
      font-size: var(--text-20);
      font-weight: var(--weight-semibold);
    }

    .summary-label,
    .section-copy {
      color: var(--text-muted);
      font-size: var(--text-12);
    }

    .section {
      margin-block-start: var(--space-6);
    }

    .section-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      margin-block-end: var(--space-3);
    }

    .section-copy {
      margin-block-start: var(--space-1);
    }

    .text-button {
      min-block-size: 36px;
      padding-inline: var(--space-2);
      color: var(--primary-ink);
      font-size: var(--text-12);
      font-weight: var(--weight-medium);
    }

    .text-button:disabled {
      opacity: 0.45;
    }

    .empty-card {
      padding: var(--space-6) var(--space-4);
      color: var(--text-muted);
      text-align: center;
    }

    .activity-list {
      overflow: hidden;
    }

    .notification-swipe {
      position: relative;
      overflow: hidden;
      background: var(--tint-selected);
    }

    .swipe-action {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding-inline-end: var(--space-5);
      color: var(--primary-ink);
      font-size: var(--text-12);
      font-weight: var(--weight-medium);
    }

    .activity-row {
      display: flex;
      align-items: center;
      inline-size: 100%;
      min-block-size: 68px;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
      color: var(--text-subtle);
      text-align: start;
      border-block-end: 1px solid var(--border-subtle);
      background: var(--bg-raised);
      transition: transform 160ms var(--ease-standard);
      touch-action: pan-y;
    }

    .activity-row.swiping {
      transition: none;
    }

    .activity-row:last-child {
      border-block-end: 0;
    }

    .activity-row:hover,
    .activity-row:focus-visible {
      background: var(--tint-hover);
    }

    .activity-row.unread strong {
      color: var(--text-strong);
    }

    .status-dot {
      flex: none;
      inline-size: 8px;
      block-size: 8px;
      border-radius: var(--radius-pill);
      background: var(--status-idle);
    }

    .status-dot[data-status='done'] {
      background: var(--status-done);
    }

    .status-dot[data-status='blocked'] {
      background: var(--status-blocked);
    }

    .status-dot[data-status='waiting'] {
      background: var(--status-waiting);
    }

    .activity-copy {
      display: flex;
      flex: 1;
      min-inline-size: 0;
      flex-direction: column;
      gap: var(--space-1);
    }

    .activity-copy strong,
    .activity-copy span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .activity-copy strong {
      color: var(--text-body);
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
    }

    .activity-copy span {
      color: var(--text-muted);
      font-size: var(--text-12);
    }

    .vault-section {
      margin-inline: calc(var(--space-5) * -1);
      margin-block-start: calc(var(--space-5) * -1);
    }

    .vault-section rl-vault {
      display: block;
    }

    .connections-section {
      margin-inline: calc(var(--space-5) * -1);
      margin-block-start: calc(var(--space-5) * -1);
    }

    .mobile-nav {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      flex: none;
      padding: var(--space-2) var(--space-3) calc(var(--space-2) + env(safe-area-inset-bottom));
      border-block-start: 1px solid var(--border-subtle);
      background: var(--bg-sunken);
    }

    .mobile-nav button {
      display: flex;
      align-items: center;
      min-block-size: 52px;
      flex-direction: column;
      justify-content: center;
      gap: var(--space-1);
      color: var(--text-muted);
      font-size: var(--text-11);
      border-radius: var(--radius-md);
      white-space: nowrap;
    }

    .mobile-nav button.active {
      color: var(--text-strong);
      background: var(--tint-selected);
    }

    .nav-icon {
      position: relative;
      display: inline-flex;
    }

    .nav-badge {
      position: absolute;
      inset-block-start: -7px;
      inset-inline-end: -10px;
      min-inline-size: 15px;
      block-size: 15px;
      padding-inline: 3px;
      color: var(--primary-ink);
      background: var(--primary);
      border-radius: var(--radius-pill);
      font-size: 9px;
      line-height: 15px;
      text-align: center;
    }

    @media (min-width: 560px) {
      .mobile-content {
        padding-inline: var(--space-8);
      }

      .vault-section {
        margin-inline: calc(var(--space-8) * -1);
      }

      .connections-section {
        margin-inline: calc(var(--space-8) * -1);
      }
    }
  `,
})
export class Mobile {
  private readonly center = inject(NotificationCenter);
  private readonly tauri = inject(TauriBridge);
  protected readonly theme = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly moduleSearch = viewChild<ElementRef<HTMLInputElement>>('moduleSearch');
  private readonly pageTitle = viewChild<ElementRef<HTMLHeadingElement>>('pageTitle');

  private railGesture: {
    pointerId: number;
    startX: number;
    startY: number;
    startTime: number;
    startedOpen: boolean;
    intent: boolean;
  } | null = null;
  private notificationSwipe: {
    notificationId: string;
    pointerId: number;
    startX: number;
    startY: number;
  } | null = null;
  private pendingRailBackAt = 0;
  private suppressClickFor: string | null = null;

  protected readonly tab = signal<MobileTab>('dashboard');
  protected readonly focusModuleSearch = signal(false);
  protected readonly focusModuleHeading = signal(false);
  protected readonly moduleQuery = signal('');
  protected readonly activeModuleIndex = signal(0);
  protected readonly moduleMatches = computed<readonly MobileModuleMatch[]>(() =>
    search(MOBILE_MODULES, this.moduleQuery()).map((match) => ({
      ...match,
      command: MOBILE_MODULES.find((module) => module.id === match.command.id)!,
    })),
  );
  protected readonly activeModule = computed(
    () => this.moduleMatches()[this.activeModuleIndex()]?.command,
  );
  protected readonly railOpen = signal(false);
  protected readonly railProgress = signal(0);
  protected readonly railGestureActive = signal(false);
  protected readonly swipeState = signal<{ notificationId: string; offset: number } | null>(null);
  protected readonly notifications = this.center.history;
  protected readonly unreadCount = computed(
    () => this.notifications().filter((notification) => !notification.read).length,
  );
  protected readonly recentNotifications = computed(() => this.notifications().slice(0, 4));
  protected readonly vaultStatus = signal<VaultStatus>({ exists: false, unlocked: false });
  protected readonly connectionSummary = signal('Not connected');
  protected readonly mobileUpdate = signal<MobileUpdate | null>(null);
  protected readonly updateBusy = signal(false);
  protected readonly tabTitle = computed(() =>
    this.tab() === 'dashboard'
      ? 'Your dashboard'
      : this.tab() === 'notifications'
        ? 'Notifications'
        : this.tab() === 'vault'
          ? 'Password vault'
          : this.tab() === 'settings'
            ? 'Settings'
            : 'Connections',
  );
  protected readonly vaultLabel = computed(() => {
    const status = this.vaultStatus();
    return !status.exists ? 'Not set up' : status.unlocked ? 'Unlocked' : 'Locked';
  });

  constructor() {
    afterRenderEffect(() => {
      if (this.focusModuleHeading()) {
        this.pageTitle()?.nativeElement.focus();
        this.focusModuleHeading.set(false);
      } else if (this.railOpen() && this.focusModuleSearch()) {
        this.moduleSearch()?.nativeElement.focus();
      }
    });
    void this.refresh();
    void this.checkForUpdate();
    void onBackButtonPress(({ canGoBack }) => {
      const edgeSwipe = Date.now() - this.pendingRailBackAt < 700;
      this.pendingRailBackAt = 0;
      if (edgeSwipe && !this.railOpen()) {
        this.setRailOpen(true);
      } else if (this.railOpen()) {
        this.closeRail();
      } else if (this.tab() !== 'dashboard') {
        this.tab.set('dashboard');
      } else if (canGoBack) {
        window.history.back();
      }
    })
      .then((listener) => this.destroyRef.onDestroy(() => void listener.unregister()))
      .catch(() => undefined);
  }

  protected async refresh(): Promise<void> {
    const [vaultStatus, githubStatus, gmailStatus] = await Promise.all([
      this.tauri.vaultStatus(),
      this.tauri.githubStatus(),
      this.tauri.gmailStatus(),
    ]);
    this.vaultStatus.set(vaultStatus);
    const connected = Number(githubStatus.connected) + Number(gmailStatus.connected);
    this.connectionSummary.set(connected === 0 ? 'Not connected' : `${connected}/2 connected`);
  }

  private async checkForUpdate(): Promise<void> {
    if (!/Android/i.test(navigator.userAgent)) return;
    try {
      this.mobileUpdate.set(await this.tauri.mobileUpdateCheck());
    } catch (error: unknown) {
      console.warn('[relay] mobile update check failed', error);
    }
  }

  protected async installUpdate(update: MobileUpdate): Promise<void> {
    if (this.updateBusy()) return;
    this.updateBusy.set(true);
    try {
      await this.tauri.openUrl(update.apkUrl);
    } finally {
      this.updateBusy.set(false);
    }
  }

  protected openNotification(notification: NotificationRecord, event?: MouseEvent): void {
    if (event && this.suppressClickFor === notification.notificationId) {
      event.preventDefault();
      event.stopPropagation();
      this.suppressClickFor = null;
      return;
    }
    this.center.markRead(notification.notificationId);
    void this.tauri.notificationsMarkRead([notification.notificationId]);

    const action = notification.actions?.find((item) => item.id === 'open');
    if (action?.id === 'open') void this.tauri.openUrl(action.url);
  }

  protected clearNotifications(): void {
    this.center.clearHistory();
    void this.tauri.notificationsClear();
  }

  protected toggleRail(): void {
    if (this.railOpen()) {
      this.closeRail();
      return;
    }

    this.openCommandMenu();
  }

  protected closeRail(): void {
    this.moduleQuery.set('');
    this.setRailOpen(false);
  }

  protected selectTab(tab: MobileTab): void {
    this.tab.set(tab);
    this.closeRail();
  }

  protected openCommandMenu(): void {
    this.moduleQuery.set('');
    this.activeModuleIndex.set(
      Math.max(
        0,
        MOBILE_MODULES.findIndex((module) => module.tab === this.tab()),
      ),
    );
    this.focusModuleSearch.set(true);
    this.setRailOpen(true);
  }

  protected onModuleQuery(value: string): void {
    this.moduleQuery.set(value);
    this.activeModuleIndex.set(0);
  }

  protected moduleIndex(match: MobileModuleMatch): number {
    return this.moduleMatches().indexOf(match);
  }

  protected moduleTitleParts(match: CommandMatch): readonly TitlePart[] {
    const parts: TitlePart[] = [];
    let cursor = 0;
    for (const [start, end] of match.ranges) {
      if (start > cursor)
        parts.push({ text: match.command.title.slice(cursor, start), matched: false });
      parts.push({ text: match.command.title.slice(start, end), matched: true });
      cursor = end;
    }
    if (cursor < match.command.title.length) {
      parts.push({ text: match.command.title.slice(cursor), matched: false });
    }
    return parts;
  }

  protected selectModule(module: MobileModule): void {
    this.selectTab(module.tab);
    this.focusModuleHeading.set(true);
  }

  protected onShellKeydown(event: KeyboardEvent): void {
    if (!this.railOpen()) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        this.openCommandMenu();
      }
      return;
    }

    if (event.target !== this.moduleSearch()?.nativeElement) {
      if (event.key === 'Escape') this.closeRail();
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveModule(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveModule(-1);
        break;
      case 'Enter':
        event.preventDefault();
        {
          const active = this.activeModule();
          if (active) this.selectModule(active);
        }
        break;
      case 'Tab':
        if (this.moduleQuery().trim()) {
          event.preventDefault();
          const active = this.activeModule();
          const input = this.moduleSearch()?.nativeElement;
          if (active && input) {
            input.value = active.title;
            this.onModuleQuery(input.value);
          }
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.closeRail();
        break;
    }
  }

  private moveModule(delta: number): void {
    const count = this.moduleMatches().length;
    if (count) this.activeModuleIndex.update((index) => (index + delta + count) % count);
  }

  protected startRailGesture(event: PointerEvent): void {
    if (!event.isPrimary) return;
    this.railGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: event.timeStamp,
      startedOpen: this.railOpen(),
      intent: false,
    };
  }

  protected moveRailGesture(event: PointerEvent): void {
    const gesture = this.railGesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.intent) {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 10) return;
      if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.15) {
        this.railGesture = null;
        return;
      }
      if (gesture.startedOpen ? deltaX >= 0 : deltaX <= 0) {
        this.railGesture = null;
        return;
      }

      gesture.intent = true;
      this.railGestureActive.set(true);
      this.railOpen.set(true);
    }

    event.preventDefault();
    const width = Math.min(window.innerWidth * 0.82, 288);
    const progress = Math.max(0, Math.min(1, (gesture.startedOpen ? 1 : 0) + deltaX / width));
    this.railProgress.set(progress);
  }

  protected endRailGesture(event: PointerEvent): void {
    const gesture = this.railGesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!gesture.intent) {
      this.railGesture = null;
      return;
    }

    const deltaX = event.clientX - gesture.startX;
    const duration = Math.max(1, event.timeStamp - gesture.startTime);
    const velocity = deltaX / duration;
    const width = Math.min(window.innerWidth * 0.82, 288);
    const progress = Math.max(0, Math.min(1, (gesture.startedOpen ? 1 : 0) + deltaX / width));
    const open = gesture.startedOpen
      ? !(progress < 0.62 || (deltaX <= -56 && velocity < -0.55))
      : progress >= 0.34 || (deltaX >= 56 && velocity > 0.55);
    this.setRailOpen(open);
  }

  protected cancelRailGesture(event?: PointerEvent): void {
    const gesture = this.railGesture;
    if (gesture && event && !this.railOpen() && gesture.startX <= 32) {
      // ponytail: pair edge pointercancel with Android Back; use native exclusion rectangles if unreliable.
      this.pendingRailBackAt = Date.now();
    }
    if (gesture) this.setRailOpen(gesture.startedOpen);
  }

  private setRailOpen(open: boolean): void {
    this.railGesture = null;
    this.railGestureActive.set(false);
    this.railOpen.set(open);
    this.railProgress.set(open ? 1 : 0);
    if (!open) {
      this.focusModuleSearch.set(false);
      this.moduleQuery.set('');
      this.activeModuleIndex.set(0);
    }
  }

  protected startNotificationSwipe(event: PointerEvent, notificationId: string): void {
    if (!event.isPrimary || event.pointerType === 'mouse') return;
    this.notificationSwipe = {
      notificationId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  protected moveNotificationSwipe(event: PointerEvent): void {
    if (!this.notificationSwipe || event.pointerId !== this.notificationSwipe.pointerId) return;
    const deltaX = event.clientX - this.notificationSwipe.startX;
    const deltaY = event.clientY - this.notificationSwipe.startY;
    if (Math.abs(deltaX) <= Math.abs(deltaY)) return;
    event.preventDefault();
    this.swipeState.set({
      notificationId: this.notificationSwipe.notificationId,
      offset: Math.max(-120, Math.min(0, deltaX)),
    });
  }

  protected endNotificationSwipe(event: PointerEvent): void {
    if (!this.notificationSwipe || event.pointerId !== this.notificationSwipe.pointerId) return;
    const deltaX = event.clientX - this.notificationSwipe.startX;
    const deltaY = event.clientY - this.notificationSwipe.startY;
    if (mobileSwipeAction(deltaX, deltaY) === 'mark-read') {
      this.suppressClickFor = this.notificationSwipe.notificationId;
      this.center.markRead(this.notificationSwipe.notificationId);
      void this.tauri.notificationsMarkRead([this.notificationSwipe.notificationId]);
    }
    this.cancelNotificationSwipe();
  }

  protected cancelNotificationSwipe(): void {
    this.notificationSwipe = null;
    this.swipeState.set(null);
  }

  protected swipeOffset(notificationId: string): number {
    const state = this.swipeState();
    return state?.notificationId === notificationId ? state.offset : 0;
  }

  protected isSwiping(notificationId: string): boolean {
    return this.swipeState()?.notificationId === notificationId;
  }
}

export function mobileSwipeAction(
  deltaX: number,
  deltaY: number,
): 'open-rail' | 'mark-read' | null {
  if (Math.abs(deltaX) <= Math.abs(deltaY) || Math.abs(deltaX) < 72) return null;
  return deltaX > 0 ? 'open-rail' : 'mark-read';
}
