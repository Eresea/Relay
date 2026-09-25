import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { TauriBridge, type WorkspaceSummary } from '@core/tauri';
import { Icon } from '@shared/icon';

const THREAD_SETTING = 'codex.lastThreadId';

@Component({
  selector: 'rl-codex',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <section class="codex" aria-labelledby="codex-title">
      <header class="page-header">
        <div>
          <p class="u-caption">Local Codex</p>
          <h1 id="codex-title">Send work to Codex</h1>
        </div>
        <button type="button" class="action" [disabled]="sending()" (click)="newThread()">
          <rl-icon name="plus" [size]="14" />
          New thread
        </button>
      </header>

      <div class="form">
        <label>
          Workspace
          <select
            [value]="workingDirectory()"
            (change)="workingDirectory.set($any($event.target).value)"
            [disabled]="sending() || loadingWorkspaces() || workspaces().length === 0"
          >
            @for (workspace of workspaces(); track workspace.path) {
              <option [value]="workspace.path">{{ workspace.name }} — {{ workspace.path }}</option>
            }
          </select>
        </label>
        @if (workspaces().length === 0 && !loadingWorkspaces()) {
          <p class="state" role="status">Relay has not discovered a local Git workspace yet.</p>
        }

        <label>
          Resume thread ID
          <input
            type="text"
            [value]="threadId()"
            (input)="threadId.set($any($event.target).value)"
            [disabled]="sending()"
            placeholder="Leave blank to start a new thread"
            autocomplete="off"
          />
        </label>

        <label>
          Prompt
          <textarea
            rows="6"
            maxlength="64000"
            placeholder="Describe the work for Codex…"
            [disabled]="sending()"
            [value]="promptText()"
            (input)="promptText.set($any($event.target).value)"
            (keydown.control.enter)="send(promptText())"
          ></textarea>
        </label>
        <p class="permission-note">
          Codex can edit this workspace and run commands without further approval. Reads include
          platform defaults. Network is disabled; requests for extra access are declined.
        </p>

        @if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        }
        <button
          type="button"
          class="primary"
          [disabled]="sending() || !workingDirectory() || !promptText().trim()"
          (click)="send(promptText())"
        >
          <rl-icon [name]="sending() ? 'loader-circle' : 'command'" [size]="14" />
          {{ sending() ? 'Waiting for Codex…' : 'Send to Codex' }}
        </button>

        @if (response()) {
          <section class="response" aria-live="polite">
            <div class="response-heading">
              <h2>Codex response</h2>
              <button type="button" class="action" (click)="openInCodex()">Open in Codex</button>
            </div>
            <pre>{{ response() }}</pre>
          </section>
        }
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
      block-size: 100%;
      overflow: auto;
    }

    .codex {
      max-inline-size: 860px;
      margin-inline: auto;
      padding: var(--space-9) var(--space-8);
    }

    .page-header,
    .response-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
    }

    .page-header {
      padding-block-end: var(--space-6);
      border-block-end: 1px solid var(--border-subtle);
    }

    .page-header h1,
    .page-header p,
    .response h2 {
      margin: 0;
    }

    .page-header h1 {
      margin-block-start: var(--space-1);
      font-size: var(--text-20);
      letter-spacing: -0.04em;
    }

    .form {
      display: grid;
      gap: var(--space-5);
      padding-block-start: var(--space-6);
    }

    label {
      display: grid;
      gap: var(--space-2);
      color: var(--text-muted);
      font-size: var(--text-12);
    }

    input,
    select,
    textarea {
      inline-size: 100%;
      min-block-size: 40px;
      padding: var(--space-3);
      color: var(--text-body);
      background: var(--bg-raised);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      font: inherit;
    }

    input:focus-visible,
    select:focus-visible,
    textarea:focus-visible {
      background: var(--bg-app);
      border-color: var(--border-focus);
      box-shadow: var(--focus-ring);
      outline: none;
    }

    textarea {
      min-block-size: 140px;
      resize: vertical;
    }

    .permission-note,
    .error,
    .state {
      margin: 0;
      font-size: var(--text-12);
    }

    .permission-note {
      color: var(--text-muted);
    }

    .error {
      color: var(--danger-ink);
    }

    .state {
      color: var(--text-muted);
    }

    .action,
    .primary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      justify-self: start;
      min-block-size: 36px;
      gap: var(--space-2);
      padding-inline: var(--space-3);
      color: var(--text-body);
      background: var(--bg-raised);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      font-size: var(--text-12);
    }

    .primary {
      color: var(--text-strong);
      border-color: var(--border-strong);
    }

    button:disabled {
      opacity: 0.55;
      cursor: wait;
    }

    .response {
      display: grid;
      gap: var(--space-3);
      padding-block-start: var(--space-5);
      border-block-start: 1px solid var(--border-subtle);
    }

    .response h2 {
      font-size: var(--text-14);
    }

    .response pre {
      margin: 0;
      padding: var(--space-4);
      color: var(--text-body);
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      font: inherit;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
})
export class Codex {
  private readonly tauri = inject(TauriBridge);

  protected readonly workspaces = signal<readonly WorkspaceSummary[]>([]);
  protected readonly workingDirectory = signal('');
  protected readonly threadId = signal('');
  protected readonly promptText = signal('');
  protected readonly response = signal('');
  protected readonly error = signal('');
  protected readonly sending = signal(false);
  protected readonly loadingWorkspaces = signal(true);

  constructor() {
    void this.load();
  }

  protected async send(prompt: string): Promise<void> {
    if (this.sending() || !prompt.trim() || !this.workingDirectory()) return;
    this.sending.set(true);
    this.error.set('');
    this.response.set('');
    try {
      const result = await this.tauri.codexSend(
        prompt,
        this.workingDirectory(),
        this.threadId().trim() || null,
      );
      this.threadId.set(result.threadId);
      this.promptText.set('');
      this.response.set(result.response);
      await this.tauri.setSetting(THREAD_SETTING, result.threadId);
    } catch (cause: unknown) {
      this.error.set(
        cause instanceof Error
          ? cause.message
          : typeof cause === 'string'
            ? cause
            : 'Could not reach Codex.',
      );
    } finally {
      this.sending.set(false);
    }
  }

  protected newThread(): void {
    this.threadId.set('');
    this.response.set('');
    this.error.set('');
    void this.tauri.setSetting(THREAD_SETTING, '');
  }

  protected openInCodex(): void {
    const id = this.threadId().trim();
    if (id) void this.tauri.openUrl(`codex://threads/${encodeURIComponent(id)}`);
  }

  private async load(): Promise<void> {
    try {
      const [workspaces, lastThreadId] = await Promise.all([
        this.tauri.scanWorkspaces(),
        this.tauri.getSetting<string>(THREAD_SETTING, ''),
      ]);
      this.workspaces.set(workspaces);
      this.workingDirectory.set(workspaces[0]?.path ?? '');
      this.threadId.set(lastThreadId);
    } catch {
      this.error.set('Could not load local workspaces. Is Relay running on the desktop?');
    } finally {
      this.loadingWorkspaces.set(false);
    }
  }
}
