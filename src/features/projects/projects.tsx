import { Fragment } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/shared/icon';
import { useController, useSignals } from '@/lib/signals';
import { inject } from '@/lib/inject';
import { signal } from '@/lib/signals';

import { BackgroundTasks } from '@/core/background-tasks';
import {
  TauriBridge,
  type GithubPullRequestSummary,
  type GithubRepositorySummary,
  type LinearConnection,
  type LinearProject,
} from '@/core/tauri';
import { IconPicker } from '@/shared/icon-picker';

import { ProjectActionsMenu, type ProjectAction } from './project-actions-menu';
import {
  mergeProjectSummaries,
  projectKey,
  type LinkedLinearProject,
  type LinearProjectWithOrganization,
  type ProjectSummary,
} from './project-summary';

import './projects.css';

export class ProjectsState {
  onLinearProjectSelected: (value: { organizationId: string; projectId: string }) => void = () =>
    undefined;

  private static readonly CACHE_KEY = 'projects.scan';
  private readonly tauri = inject(TauriBridge);
  private readonly backgroundTasks = inject(BackgroundTasks);
  readonly projects = signal<readonly ProjectSummary[]>([]);
  readonly loading = signal(true);
  readonly syncing = signal(false);
  readonly error = signal('');

  constructor() {
    void this.restore();
  }

  private async restore(): Promise<void> {
    try {
      const saved = await this.tauri.getSetting<readonly ProjectSummary[]>(
        ProjectsState.CACHE_KEY,
        [],
      );
      this.projects.set(
        saved.map((project) => ({ ...project, linearProjects: project.linearProjects ?? [] })),
      );
    } catch {
      this.error.set('Could not load saved projects.');
    } finally {
      this.loading.set(false);
    }
  }

  async sync(): Promise<void> {
    if (this.syncing()) return;
    this.syncing.set(true);
    this.error.set('');
    try {
      const workspaces = await this.tauri.scanWorkspaces();
      const warnings: string[] = [];
      let repositories: readonly GithubRepositorySummary[] = [];
      let pullRequests: readonly GithubPullRequestSummary[] = [];
      try {
        repositories = await this.tauri.githubRepositories();
        pullRequests = await this.tauri.githubPullRequests();
      } catch {
        warnings.push('GitHub sync failed. Local projects are still shown.');
      }
      const savedProjects = new Map(
        this.projects().map((project) => [projectKey(project), project]),
      );
      const linearProjects: LinearProjectWithOrganization[] = [];
      let linearSyncFailed = false;
      try {
        const connections = await this.tauri.linearStatus();
        const activeConnections = connections.filter((connection) => !connection.pausedOnDevice);
        const results = await Promise.allSettled(
          activeConnections.map(async (connection) => ({
            connection,
            projects: await this.tauri.linearProjects(connection.organizationId),
          })),
        );
        for (const result of results) {
          if (result.status === 'rejected') {
            linearSyncFailed = true;
            continue;
          }
          linearProjects.push(...withOrganization(result.value.connection, result.value.projects));
        }
        if (linearSyncFailed) warnings.push('Some Linear projects could not be synced.');
      } catch {
        linearSyncFailed = true;
        warnings.push('Linear sync failed. Saved project links are still shown.');
      }
      const savedIcons = new Map(
        this.projects().map((project) => [projectKey(project), project.icon ?? 'folder']),
      );
      const projects = mergeProjectSummaries(
        workspaces,
        repositories,
        pullRequests,
        linearProjects,
      ).map((project) => {
        const saved = savedProjects.get(projectKey(project));
        return {
          ...project,
          icon: savedIcons.get(projectKey(project)) ?? 'folder',
          linearProjects: linearSyncFailed
            ? mergeLinearProjects(project.linearProjects, saved?.linearProjects ?? [])
            : project.linearProjects,
        };
      });
      this.projects.set(projects);
      this.error.set(warnings.join(' '));
      try {
        await this.tauri.setSetting(ProjectsState.CACHE_KEY, projects);
      } catch {
        this.error.set('Could not save project scan.');
      }
    } catch {
      this.error.set('Could not scan local disks.');
    } finally {
      this.syncing.set(false);
    }
  }

  setProjectIcon(project: ProjectSummary, icon: string): void {
    const projects = this.projects().map((current) =>
      projectKey(current) === projectKey(project) ? { ...current, icon } : current,
    );
    this.projects.set(projects);
    void this.tauri.setSetting(ProjectsState.CACHE_KEY, projects);
  }

  open(project: ProjectSummary): void {
    if (project.path) void this.tauri.openPath(project.path);
    else if (project.githubUrl) void this.tauri.openUrl(project.githubUrl);
  }

  openTerminal(project: ProjectSummary): void {
    if (project.path) void this.tauri.openTerminal(project.path);
  }

  openLinearProject(project: LinkedLinearProject): void {
    this.onLinearProjectSelected({
      organizationId: project.organizationId,
      projectId: project.id,
    });
  }

  runProjectAction(project: ProjectSummary, action: ProjectAction): void {
    switch (action.id) {
      case 'open':
        this.open(project);
        return;
      case 'terminal':
        this.openTerminal(project);
        return;
      case 'github':
        if (project.githubUrl) void this.tauri.openUrl(project.githubUrl);
        return;
      case 'pullRequests':
        if (project.githubUrl)
          void this.tauri.openUrl(project.githubUrl.replace(/\/$/, '') + '/pulls');
        return;
      case 'copyPath':
        if (project.path) void navigator.clipboard?.writeText(project.path);
        return;
      case 'copyUrl':
        if (project.githubUrl) void navigator.clipboard?.writeText(project.githubUrl);
        return;
      default:
        if (!project.path) return;
        void this.backgroundTasks
          .run(this.describeAction(project, action), () =>
            this.tauri.runProjectAction(project.path!, action),
          )
          .then(() => {
            if (action.id !== 'gitSwitch') return;
            this.projects.set(
              this.projects().map((current) =>
                projectKey(current) === projectKey(project)
                  ? { ...current, currentBranch: action.branch }
                  : current,
              ),
            );
          })
          .catch(() => {
            this.error.set('Could not run that project action.');
          });
    }
  }

  private describeAction(project: ProjectSummary, action: ProjectAction): string {
    switch (action.id) {
      case 'gitFetch':
        return `Fetching ${project.name}`;
      case 'gitPull':
        return `Pulling ${project.name}`;
      case 'gitSwitch':
        return `Switching ${project.name} to ${action.branch}`;
      case 'runScript':
        return `Running npm run ${action.script} in ${project.name}`;
      default:
        return `Working on ${project.name}`;
    }
  }

  formatModified(timestamp: string): string {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
      Date.parse(timestamp),
    );
  }

  formatSize(sizeKb: number): string {
    return sizeKb >= 1024 ? (sizeKb / 1024).toFixed(1) + ' MB' : Math.round(sizeKb) + ' KB';
  }

  waitingCount(project: ProjectSummary): number {
    return project.pullRequests.filter((pullRequest) => pullRequest.reviewRequested).length;
  }

  ciState(project: ProjectSummary): GithubPullRequestSummary['ciState'] {
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

function withOrganization(
  connection: LinearConnection,
  projects: readonly LinearProject[],
): LinearProjectWithOrganization[] {
  return projects.map((project) => ({
    ...project,
    organizationId: connection.organizationId,
    organizationName: connection.organizationName,
  }));
}

function mergeLinearProjects(
  current: ProjectSummary['linearProjects'],
  cached: ProjectSummary['linearProjects'],
): ProjectSummary['linearProjects'] {
  return [
    ...current,
    ...cached.filter(
      (cachedProject) =>
        !current.some(
          (project) =>
            project.organizationId === cachedProject.organizationId &&
            project.id === cachedProject.id,
        ),
    ),
  ];
}

export default function Projects(props: {
  onLinearProjectSelected?: (value: { organizationId: string; projectId: string }) => void;
}) {
  useSignals();
  const s = useController(() => new ProjectsState());
  if (props.onLinearProjectSelected) s.onLinearProjectSelected = props.onLinearProjectSelected;
  return (
    <div className="projects">
      <section className="projects" aria-labelledby="projects-title">
        <header className="page-header">
          <div>
            <p className="u-caption">Workspace</p>
            <h1 id="projects-title">Projects</h1>
            <p className="page-description">
              Local projects, GitHub repositories, and linked Linear projects.
            </p>
          </div>
          <Button
            size="sm"
            disabled={s.loading() || s.syncing()}
            onClick={() => {
              void s.sync();
            }}
          >
            <Icon name={s.syncing() ? 'loader-circle' : 'search'} size={14} />
            {s.syncing() ? 'Syncing' : 'Sync projects'}
          </Button>
        </header>

        {s.error() ? (
          <>
            <p className="error" role="alert">
              {s.error()}
            </p>
          </>
        ) : null}

        {s.loading() ? (
          <>
            <div className="empty-state" aria-live="polite">
              <Icon name="loader-circle" size={20} />
              <p className="empty-title">Loading saved projects</p>
            </div>
          </>
        ) : s.syncing() ? (
          <>
            <div className="empty-state" aria-live="polite">
              <Icon name="loader-circle" size={20} />
              <p className="empty-title">Finding your projects</p>
              <p className="empty-description">
                Scanning mounted disks and checking GitHub for recent repositories.
              </p>
            </div>
          </>
        ) : s.projects().length === 0 ? (
          <>
            <div className="empty-state">
              <Icon name="folder" size={20} />
              <p className="empty-title">No projects found</p>
              <p className="empty-description">
                Sync to discover local clones and GitHub repositories.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="project-list" role="list">
              {s.projects().map((project) => {
                return (
                  <Fragment key={project.path ?? project.githubRepo ?? project.name}>
                    <article className="project-row" role="listitem">
                      <span className="project-glyph">
                        <IconPicker
                          value={project.icon ?? 'folder'}
                          label={'Choose icon for ' + project.name}
                          onValueChange={($event) => {
                            void s.setProjectIcon(project, $event);
                          }}
                        />
                      </span>
                      <div className="project-copy">
                        <p className="project-name">{project.name}</p>
                        <p className="project-path">{project.path ?? 'No local workspace'}</p>
                        {project.githubRepo ? (
                          <>
                            <p className="project-remote">github.com/{project.githubRepo}</p>
                          </>
                        ) : null}
                        {project.linearProjects.map((linearProject) => {
                          return (
                            <Fragment key={linearProject.organizationId + ':' + linearProject.id}>
                              <Button
                                className="linear-project-link"
                                size="sm"
                                variant="link"
                                aria-label={'Open Linear project ' + linearProject.name}
                                onClick={() => {
                                  void s.openLinearProject(linearProject);
                                }}
                              >
                                {linearProject.organizationName} · {linearProject.name}
                              </Button>
                            </Fragment>
                          );
                        })}
                        {project.sizeKb !== null || project.pushedAt || project.visibility ? (
                          <>
                            <p className="project-remote">
                              {project.sizeKb !== null ? <>{s.formatSize(project.sizeKb)}</> : null}
                              {project.pushedAt ? (
                                <>· pushed {s.formatModified(project.pushedAt)}</>
                              ) : null}
                              {project.visibility ? <>· {project.visibility}</> : null}
                            </p>
                          </>
                        ) : null}
                        {project.pullRequests.length ? (
                          <>
                            <p className="project-signals">
                              {s.waitingCount(project) ? (
                                <>
                                  <span>
                                    <span className="status-dot waiting" />
                                    {s.waitingCount(project)} waiting
                                  </span>
                                </>
                              ) : null}
                              {s.ciState(project) === 'failure' ? (
                                <>
                                  <span>
                                    <span className="status-dot failure" />
                                    CI failing
                                  </span>
                                </>
                              ) : s.ciState(project) === 'pending' ? (
                                <>
                                  <span>
                                    <span className="status-dot pending" />
                                    CI running
                                  </span>
                                </>
                              ) : s.ciState(project) === 'success' ? (
                                <>
                                  <span>
                                    <span className="status-dot success" />
                                    CI passing
                                  </span>
                                </>
                              ) : null}
                            </p>
                          </>
                        ) : null}
                      </div>
                      <div className="project-actions">
                        {project.path ? (
                          <>
                            <Button
                              size="sm"
                              variant="link"
                              onClick={() => {
                                void s.open(project);
                              }}
                            >
                              Open
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                void s.openTerminal(project);
                              }}
                            >
                              Terminal
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                void s.open(project);
                              }}
                            >
                              View
                            </Button>
                          </>
                        )}
                        <ProjectActionsMenu
                          project={project}
                          onAction={($event) => {
                            void s.runProjectAction(project, $event);
                          }}
                        />
                      </div>
                    </article>
                  </Fragment>
                );
              })}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
