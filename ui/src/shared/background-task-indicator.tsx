import { BackgroundTasks } from '@/core/background-tasks';
import { inject } from '@/lib/inject';
import { useSignals } from '@/lib/signals';

import { Icon } from './icon';

/** The latest in-flight background task, so slow work never looks like a hang. */
export function BackgroundTaskIndicator() {
  useSignals();
  const task = inject(BackgroundTasks).active();
  return (
    <div className="min-w-0 flex-1">
      {task && (
        <div
          className="flex items-center gap-(--space-2) text-subtle"
          role="status"
          aria-live="polite"
        >
          <Icon
            name="loader-circle"
            size={14}
            className="animate-spin motion-reduce:animate-none"
          />
          <span className="truncate text-(length:--text-11)">{task.label}</span>
        </div>
      )}
    </div>
  );
}
