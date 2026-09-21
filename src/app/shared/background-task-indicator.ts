import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { BackgroundTasks } from '@core/background-tasks';

import { Icon } from './icon';

@Component({
  selector: 'rl-background-task-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @if (tasks.active(); as task) {
      <div class="task" role="status" aria-live="polite">
        <rl-icon name="loader-circle" [size]="14" class="spinner" />
        <span class="label">{{ task.label }}</span>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      flex: 1;
      min-inline-size: 0;
    }

    .task {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      color: var(--text-subtle);
    }

    .spinner {
      flex: none;
      animation: task-spin 0.8s linear infinite;
    }

    .label {
      overflow: hidden;
      font-size: var(--text-11);
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    @keyframes task-spin {
      to {
        transform: rotate(360deg);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .spinner {
        animation: none;
      }
    }
  `,
})
export class BackgroundTaskIndicator {
  protected readonly tasks = inject(BackgroundTasks);
}
