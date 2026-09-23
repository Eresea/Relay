import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { AppPopover, PopoverContent, PopoverTrigger } from '@shared/app-popover';
import { Icon } from '@shared/icon';
import { MenuSubmenu, SubmenuContent } from '@shared/menu-submenu';

import type { ProjectSummary } from './project-summary';

export type ProjectAction =
  | { readonly id: 'open' }
  | { readonly id: 'terminal' }
  | { readonly id: 'github' }
  | { readonly id: 'pullRequests' }
  | { readonly id: 'copyPath' }
  | { readonly id: 'copyUrl' }
  | { readonly id: 'gitFetch' }
  | { readonly id: 'gitPull' }
  | { readonly id: 'gitSwitch'; readonly branch: string }
  | { readonly id: 'runScript'; readonly script: string };

@Component({
  selector: 'rl-project-actions-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppPopover, Icon, MenuSubmenu, PopoverContent, PopoverTrigger, SubmenuContent],
  template: `
    <rl-app-popover surfaceRole="menu">
      <button
        type="button"
        class="trigger"
        rlPopoverTrigger
        [attr.aria-label]="'Actions for ' + project().name"
      >
        <rl-icon name="ellipsis" [size]="16" />
      </button>
      <div
        rlPopoverContent
        class="menu"
        role="menu"
        [attr.aria-label]="project().name + ' actions'"
      >
        <section class="menu-section">
          <p class="section-label">Project</p>
          <button type="button" role="menuitem" (click)="select({ id: 'open' })">Open</button>
          @if (project().path) {
            <button type="button" role="menuitem" (click)="select({ id: 'terminal' })">
              Open terminal
            </button>
            <button
              type="button"
              role="menuitem"
              (click)="select({ id: 'copyPath' })"
              [attr.aria-label]="
                copiedAction() === 'copyPath' ? 'Path copied to clipboard' : 'Copy path'
              "
            >
              {{ copiedAction() === 'copyPath' ? 'Path copied!' : 'Copy path' }}
            </button>
          }
          @if (project().githubUrl) {
            <button type="button" role="menuitem" (click)="select({ id: 'github' })">
              Open GitHub
            </button>
            @if (project().pullRequests.length) {
              <button type="button" role="menuitem" (click)="select({ id: 'pullRequests' })">
                Pull requests
              </button>
            }
            <button
              type="button"
              role="menuitem"
              (click)="select({ id: 'copyUrl' })"
              [attr.aria-label]="
                copiedAction() === 'copyUrl' ? 'GitHub URL copied to clipboard' : 'Copy GitHub URL'
              "
            >
              {{ copiedAction() === 'copyUrl' ? 'URL copied!' : 'Copy GitHub URL' }}
            </button>
          }
        </section>

        @if (project().path) {
          <section class="menu-section">
            <rl-menu-submenu label="Git">
              <ng-container rlSubmenuContent>
                <button type="button" role="menuitem" (click)="select({ id: 'gitFetch' })">
                  Fetch
                </button>
                <button type="button" role="menuitem" (click)="select({ id: 'gitPull' })">
                  Pull
                </button>
                @if (project().branches?.length) {
                  <rl-menu-submenu label="Switch branch">
                    <ng-container rlSubmenuContent>
                      @for (branch of project().branches; track branch) {
                        <button
                          type="button"
                          role="menuitem"
                          [class.active]="branch === project().currentBranch"
                          (click)="select({ id: 'gitSwitch', branch })"
                        >
                          {{ branch }}
                        </button>
                      }
                    </ng-container>
                  </rl-menu-submenu>
                }
              </ng-container>
            </rl-menu-submenu>
          </section>

          @if (project().packageScripts?.length) {
            <section class="menu-section">
              <rl-menu-submenu label="Scripts">
                <ng-container rlSubmenuContent>
                  @for (script of project().packageScripts; track script) {
                    <button
                      type="button"
                      role="menuitem"
                      (click)="select({ id: 'runScript', script })"
                    >
                      npm run {{ script }}
                    </button>
                  }
                </ng-container>
              </rl-menu-submenu>
            </section>
          }
        }
      </div>
    </rl-app-popover>
  `,
  styles: `
    :host {
      display: inline-flex;
    }

    .trigger {
      display: inline-grid;
      place-items: center;
      inline-size: var(--control-sm);
      block-size: var(--control-sm);
      color: var(--text-muted);
      border-radius: var(--radius-sm);
    }

    .trigger:hover,
    .trigger[aria-expanded='true'] {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    .menu {
      min-inline-size: 190px;
      max-block-size: 360px;
      overflow-y: auto;
      padding: var(--space-2);
    }

    .menu-section + .menu-section {
      margin-block-start: var(--space-2);
      padding-block-start: var(--space-2);
      border-block-start: 1px solid var(--border-subtle);
    }

    .section-label {
      margin: 0;
      padding: var(--space-2) var(--space-3);
      color: var(--text-subtle);
      font-size: var(--text-11);
      font-weight: var(--weight-medium);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .menu button[role='menuitem'] {
      display: block;
      inline-size: 100%;
      padding: var(--space-2) var(--space-3);
      color: var(--text-body);
      border-radius: var(--radius-sm);
      text-align: start;
      white-space: nowrap;
    }

    .menu button[role='menuitem']:hover,
    .menu button[role='menuitem'].active {
      color: var(--text-strong);
      background: var(--tint-hover);
    }
  `,
})
export class ProjectActionsMenu {
  readonly project = input.required<ProjectSummary>();
  readonly action = output<ProjectAction>();
  private readonly popover = viewChild.required(AppPopover);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly copiedAction = signal<'copyPath' | 'copyUrl' | null>(null);
  private copyTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.copyTimeout) clearTimeout(this.copyTimeout);
    });
  }

  protected select(action: ProjectAction): void {
    if (action.id === 'copyPath' || action.id === 'copyUrl') {
      this.action.emit(action);
      if (this.copyTimeout) clearTimeout(this.copyTimeout);
      this.copiedAction.set(action.id);
      this.copyTimeout = setTimeout(() => {
        this.copiedAction.set(null);
        this.popover().close();
      }, 1500);
      return;
    }

    this.action.emit(action);
    this.popover().close();
  }
}
