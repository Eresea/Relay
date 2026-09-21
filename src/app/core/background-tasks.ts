import { computed, Injectable, signal } from '@angular/core';

export interface BackgroundTask {
  readonly id: number;
  readonly label: string;
}

let nextTaskId = 0;

/** Tracks in-flight async work (git fetch/pull, project scans, …) so the
 * status bar can show it's doing something instead of the UI just
 * appearing to hang. */
@Injectable({ providedIn: 'root' })
export class BackgroundTasks {
  private readonly tasks = signal<readonly BackgroundTask[]>([]);

  readonly active = computed(() => this.tasks().at(-1) ?? null);
  readonly busy = computed(() => this.tasks().length > 0);

  async run<T>(label: string, action: () => Promise<T>): Promise<T> {
    const task: BackgroundTask = { id: nextTaskId++, label };
    this.tasks.update((tasks) => [...tasks, task]);
    try {
      return await action();
    } finally {
      this.tasks.update((tasks) => tasks.filter((current) => current.id !== task.id));
    }
  }
}
