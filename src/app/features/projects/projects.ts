import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import {
  TauriBridge,
  type GithubPullRequestSummary,
  type GithubRepositorySummary,
} from '@core/tauri';
import { Icon } from '@shared/icon';

import { mergeProjectSummaries, type ProjectSummary } from './project-summary';

@Component({
  selector: 'rl-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <section class="projects" aria-labelledby="projects-title">
      <header class="page-header">
        <div>
          <p class="u-caption">Workspace</p>
          <h1 id="projects-title">Projects</h1>
          <p class="page-description">Local clones and recent GitHub repositories.</p>
        </div>
        <button type="button" class="scan-button" [disabled]="syncing()" (click)="sync()">
          <rl-icon [name]="syncing() ? 'loader-circle' : 'search'" [size]="14" />
          {{ syncing() ? 'Syncing' : 'Sync projects' }}
        </button>
      </header>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      @if (syncing()) {
        <div class="empty-state" aria-live="polite">
          <rl-icon name="loader-circle" [size]="20" />
          <p class="empty-title">Finding your projects</p>
          <p class="empty-description">
            Scanning mounted disks and checking GitHub for recent repositories.
          </p>
        </div>
      } @else if (projects().length === 0) {
        <div class="empty-state">
          <rl-icon name="folder" [size]="20" />
          <p class="empty-title">No projects found</p>
          <p class="empty-description">Connect GitHub or clone a repository, then sync again.</p>
        </div>
      } @else {
        <div class="project-list" role="list">
          @for (project of projects(); track project.githubRepo ?? project.path) {
            <article class="project-row" role="listitem">
              <span class="project-glyph"><rl-icon name="folder" [size]="16" /></span>
              <div class="project-copy">
                <p class="project-name">{{ project.name }}</p>
                <p class="project-path">{{ project.path ?? 'No local workspace' }}</p>
                @if (project.githubRepo) {
                  <p class="project-remote">github.com/{{ project.githubRepo }}</p>
                }
                @if (project.sizeKb !== null || project.pushedAt || project.visibility) {
                  <p class="project-remote">
                    @if (project.sizeKb !== null) {
                      {{ formatSize(project.sizeKb) }}
                    }
                    @if (project.pushedAt) {
                      · pushed {{ formatModified(project.pushedAt) }}
                    }
                    @if (project.visibility) {
                      · {{ project.visibility }}
                    }
                  </p>
                }
                @if (project.pullRequests.length) {
                  <p class="project-signals">
                    @if (waitingCount(project)) {
                      <span
                        ><span class="status-dot waiting"></span
                        >{{ waitingCount(project) }} waiting</span
                      >
                    }
                    @if (ciState(project) === 'failure') {
                      <span><span class="status-dot failure"></span>CI failing</span>
                    } @else if (ciState(project) === 'pending') {
                      <span><span class="status-dot pending"></span>CI running</span>
                    } @else if (ciState(project) === 'success') {
                      <span><span class="status-dot success"></span>CI passing</span>
                    }
                  </p>
                }
              </div>
              <button
                type="button"
                class="open-button"
                (click)="open(project)"
                [attr.aria-label]="(project.path ? 'Open ' : 'View ') + project.name"
              >
                {{ project.path ? 'Open' : 'View' }}
              </button>
            </article>
          }
        </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-block-size: 100%;
    }

    .projects {
      max-inline-size: 860px;
      margin: 0 auto;
      padding: var(--space-9) var(--space-8);
    }

    .page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-7);
      padding-block-end: var(--space-7);
      border-block-end: 1px solid var(--border-subtle);
    }

    h1,
    .page-description,
    .empty-title,
    .empty-description,
    .error,
    .project-name,
    .project-path,
    .project-remote {
      margin: 0;
    }

    h1 {
      margin-block-start: var(--space-2);
      font-size: var(--text-20);
      font-weight: var(--weight-semibold);
      letter-spacing: -0.04em;
      color: var(--text-strong);
    }

    .page-description {
      margin-block-start: var(--space-2);
      font-size: var(--text-13);
      color: var(--text-muted);
    }

    .scan-button,
    .open-button {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      flex: none;
      border-radius: var(--radius-sm);
      font-size: var(--text-12);
      font-weight: var(--weight-medium);
    }

    .scan-button {
      min-block-size: var(--control-sm);
      padding-inline: var(--space-3);
      color: var(--primary-ink);
      background: var(--primary);
    }

    .scan-button:hover:not(:disabled) {
      background: var(--primary-hover);
    }

    .scan-button:disabled {
      opacity: 0.7;
    }

    .empty-state {
      display: grid;
      justify-items: center;
      padding: var(--space-10) var(--space-7);
      text-align: center;
      color: var(--text-subtle);
    }

    .empty-title {
      margin-block-start: var(--space-4);
      color: var(--text-body);
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
    }

    .empty-description {
      max-inline-size: 360px;
      margin-block-start: var(--space-2);
      font-size: var(--text-12);
      line-height: 1.5;
      color: var(--text-muted);
    }

    .error {
      padding-block: var(--space-4);
      color: var(--danger-ink);
      font-size: var(--text-12);
      background: var(--danger-tint);
    }

    .project-list {
      border-block-end: 1px solid var(--border-subtle);
    }

    .project-row {
      display: flex;
      align-items: center;
      gap: var(--space-5);
      min-block-size: 72px;
      padding-block: var(--space-5);
      border-block-end: 1px solid var(--border-subtle);
    }

    .project-row:last-child {
      border-block-end: 0;
    }

    .project-glyph {
      display: grid;
      place-items: center;
      inline-size: 30px;
      block-size: 30px;
      flex: none;
      color: var(--text-muted);
      background: var(--bg-raised);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
    }

    .project-copy {
      min-inline-size: 0;
      flex: 1;
    }

    .project-name {
      overflow: hidden;
      color: var(--text-body);
      font-size: var(--text-13);
      font-weight: var(--weight-medium);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .project-path,
    .project-remote {
      overflow: hidden;
      margin-block-start: var(--space-1);
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: var(--text-11);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .project-remote {
      color: var(--text-subtle);
    }

    .project-signals {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-4);
      margin: var(--space-2) 0 0;
      color: var(--text-muted);
      font-size: var(--text-11);
    }

    .project-signals span {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
    }

    .status-dot {
      inline-size: 6px;
      block-size: 6px;
      border-radius: 50%;
    }

    .status-dot.waiting {
      background: var(--status-waiting);
    }

    .status-dot.failure {
      background: var(--status-blocked);
    }

    .status-dot.pending {
      background: var(--status-running);
    }

    .status-dot.success {
      background: var(--status-done);
    }

    .open-button {
      padding: var(--space-2) var(--space-3);
      color: var(--text-muted);
    }

    .open-button:hover {
      color: var(--text-body);
      background: var(--tint-hover);
    }

    @media (max-width: 620px) {
      .projects {
        padding-inline: var(--space-6);
      }

      .page-header {
        align-items: stretch;
        flex-direction: column;
      }

      .scan-button {
        align-self: flex-start;
      }
    }
  `,
})
export class Projects {
  private readonly tauri = inject(TauriBridge);
  protected readonly projects = signal<readonly ProjectSummary[]>([]);
  protected readonly syncing = signal(false);
  protected readonly error = signal('');

  constructor() {
    void this.sync();
  }

  protected async sync(): Promise<void> {
    if (this.syncing()) return;
    this.syncing.set(true);
    this.error.set('');
    try {
      const workspaces = await this.tauri.scanWorkspaces();
      let repositories: readonly GithubRepositorySummary[] = [];
      let pullRequests: readonly GithubPullRequestSummary[] = [];
      try {
        repositories = await this.tauri.githubRepositories();
        pullRequests = await this.tauri.githubPullRequests();
      } catch {
        this.error.set('GitHub sync failed. Local clones are still shown.');
      }
      this.projects.set(mergeProjectSummaries(workspaces, repositories, pullRequests));
    } catch {
      this.error.set('Could not scan local disks.');
    } finally {
      this.syncing.set(false);
    }
  }

  protected open(project: ProjectSummary): void {
    if (project.path) void this.tauri.openPath(project.path);
    else if (project.githubUrl) void this.tauri.openUrl(project.githubUrl);
  }

  protected formatModified(timestamp: string): string {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
      Date.parse(timestamp),
    );
  }

  protected formatSize(sizeKb: number): string {
    return sizeKb >= 1024 ? (sizeKb / 1024).toFixed(1) + ' MB' : Math.round(sizeKb) + ' KB';
  }

  protected waitingCount(project: ProjectSummary): number {
    return project.pullRequests.filter((pullRequest) => pullRequest.reviewRequested).length;
  }

  protected ciState(project: ProjectSummary): GithubPullRequestSummary['ciState'] {
    if (project.pullRequests.some((pullRequest) => pullRequest.ciState === 'failure')) {
      return 'failure';
    }
    if (project.pullRequests.some((pullRequest) => pullRequest.ciState === 'pending')) {
      return 'pending';
    }
    if (
      project.pullRequests.length > 0 &&
      project.pullRequests.every((pullRequest) => pullRequest.ciState === 'success')
    ) {
      return 'success';
    }
    return null;
  }
}
