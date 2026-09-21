import type {
  GithubPullRequestSummary,
  GithubRepositorySummary,
  WorkspaceSummary,
} from '@core/tauri';

export interface ProjectSummary {
  readonly name: string;
  readonly path: string | null;
  readonly githubRepo: string | null;
  readonly githubUrl: string | null;
  readonly visibility: string | null;
  readonly sizeKb: number | null;
  readonly pushedAt: string | null;
  readonly modifiedAt: number | null;
  readonly pullRequests: readonly GithubPullRequestSummary[];
}

export function mergeProjectSummaries(
  workspaces: readonly WorkspaceSummary[],
  repositories: readonly GithubRepositorySummary[],
  pullRequests: readonly GithubPullRequestSummary[] = [],
): readonly ProjectSummary[] {
  const byRepo = new Map(repositories.map((repository) => [key(repository.fullName), repository]));
  const pullRequestsByRepo = new Map<string, GithubPullRequestSummary[]>();
  for (const pullRequest of pullRequests) {
    const current = pullRequestsByRepo.get(key(pullRequest.repository)) ?? [];
    current.push(pullRequest);
    pullRequestsByRepo.set(key(pullRequest.repository), current);
  }
  const matched = new Set<string>();
  const projects = workspaces.map((workspace) => {
    const repository = workspace.githubRepo ? byRepo.get(key(workspace.githubRepo)) : undefined;
    if (repository) matched.add(key(repository.fullName));
    return project(repository, workspace, pullRequestsByRepo);
  });

  for (const repository of repositories) {
    if (!matched.has(key(repository.fullName))) {
      projects.push(project(repository, null, pullRequestsByRepo));
    }
  }

  return projects.sort((left, right) => {
    const activity = activityAt(right) - activityAt(left);
    return activity || left.name.localeCompare(right.name);
  });
}

function project(
  repository: GithubRepositorySummary | undefined,
  workspace: WorkspaceSummary | null,
  pullRequestsByRepo: ReadonlyMap<string, readonly GithubPullRequestSummary[]>,
): ProjectSummary {
  const githubRepo = repository?.fullName ?? workspace?.githubRepo ?? null;
  return {
    name: workspace?.name ?? repository?.name ?? 'Project',
    path: workspace?.path ?? null,
    githubRepo,
    githubUrl: repository?.htmlUrl ?? null,
    visibility: repository?.visibility ?? null,
    sizeKb: repository?.sizeKb ?? null,
    pushedAt: repository?.pushedAt ?? null,
    modifiedAt: workspace?.modifiedAt ?? null,
    pullRequests: githubRepo ? (pullRequestsByRepo.get(key(githubRepo)) ?? []) : [],
  };
}

function activityAt(project: ProjectSummary): number {
  const pushedAt = project.pushedAt ? Date.parse(project.pushedAt) : Number.NaN;
  return Number.isFinite(pushedAt) ? pushedAt : (project.modifiedAt ?? 0) * 1000;
}

function key(repository: string): string {
  return repository.trim().toLowerCase();
}
