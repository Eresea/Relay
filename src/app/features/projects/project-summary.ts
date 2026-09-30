import type {
  GithubPullRequestSummary,
  GithubRepositorySummary,
  LinearProject,
  WorkspaceSummary,
} from '@core/tauri';

export interface LinkedLinearProject extends Pick<LinearProject, 'id' | 'name' | 'url'> {
  readonly organizationId: string;
  readonly organizationName: string;
}

export interface LinearProjectWithOrganization extends LinearProject {
  readonly organizationId: string;
  readonly organizationName: string;
}

export interface ProjectSummary {
  readonly name: string;
  readonly path: string | null;
  readonly icon?: string;
  readonly githubRepo: string | null;
  readonly githubUrl: string | null;
  readonly visibility: string | null;
  readonly sizeKb: number | null;
  readonly pushedAt: string | null;
  readonly modifiedAt: number | null;
  readonly currentBranch?: string | null;
  readonly branches?: readonly string[];
  readonly packageScripts?: readonly string[];
  readonly pullRequests: readonly GithubPullRequestSummary[];
  readonly linearProjects: readonly LinkedLinearProject[];
}

export function mergeProjectSummaries(
  workspaces: readonly WorkspaceSummary[],
  repositories: readonly GithubRepositorySummary[],
  pullRequests: readonly GithubPullRequestSummary[] = [],
  linearProjects: readonly LinearProjectWithOrganization[] = [],
): readonly ProjectSummary[] {
  const byRepo = new Map(repositories.map((repository) => [key(repository.fullName), repository]));
  const pullRequestsByRepo = new Map<string, GithubPullRequestSummary[]>();
  for (const pullRequest of pullRequests) {
    const current = pullRequestsByRepo.get(key(pullRequest.repository)) ?? [];
    current.push(pullRequest);
    pullRequestsByRepo.set(key(pullRequest.repository), current);
  }
  const matched = new Set<string>();
  const linearProjectsByRepo = new Map<string, LinkedLinearProject[]>();
  for (const project of linearProjects) {
    const link = {
      id: project.id,
      name: project.name,
      url: project.url,
      organizationId: project.organizationId,
      organizationName: project.organizationName,
    };
    for (const externalLink of project.externalLinks) {
      const repository = githubRepository(externalLink.url);
      if (!repository) continue;
      const current = linearProjectsByRepo.get(repository) ?? [];
      if (
        !current.some((item) => item.organizationId === link.organizationId && item.id === link.id)
      ) {
        current.push(link);
        linearProjectsByRepo.set(repository, current);
      }
    }
  }
  const projects = workspaces.map((workspace) => {
    const repository = workspace.githubRepo ? byRepo.get(key(workspace.githubRepo)) : undefined;
    if (repository) matched.add(key(repository.fullName));
    return project(repository, workspace, pullRequestsByRepo, linearProjectsByRepo);
  });

  for (const repository of repositories) {
    if (!matched.has(key(repository.fullName))) {
      projects.push(project(repository, null, pullRequestsByRepo, linearProjectsByRepo));
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
  linearProjectsByRepo: ReadonlyMap<string, readonly LinkedLinearProject[]>,
): ProjectSummary {
  const githubRepo = repository?.fullName ?? workspace?.githubRepo ?? null;
  return {
    name: workspace?.name ?? repository?.name ?? 'Project',
    path: workspace?.path ?? null,
    icon: 'folder',
    githubRepo,
    githubUrl: repository?.htmlUrl ?? null,
    visibility: repository?.visibility ?? null,
    sizeKb: repository?.sizeKb ?? null,
    pushedAt: repository?.pushedAt ?? null,
    modifiedAt: workspace?.modifiedAt ?? null,
    currentBranch: workspace?.currentBranch ?? null,
    branches: workspace?.branches ?? [],
    packageScripts: workspace?.packageScripts ?? [],
    pullRequests: githubRepo ? (pullRequestsByRepo.get(key(githubRepo)) ?? []) : [],
    linearProjects: githubRepo ? (linearProjectsByRepo.get(key(githubRepo)) ?? []) : [],
  };
}

export function projectKey(project: Pick<ProjectSummary, 'name' | 'path' | 'githubRepo'>): string {
  return (project.githubRepo ?? project.path ?? project.name).trim().toLowerCase();
}

function activityAt(project: ProjectSummary): number {
  const pushedAt = project.pushedAt ? Date.parse(project.pushedAt) : Number.NaN;
  return Number.isFinite(pushedAt) ? pushedAt : (project.modifiedAt ?? 0) * 1000;
}

function key(repository: string): string {
  return repository.trim().toLowerCase();
}

function githubRepository(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;
    const [owner, name, ...rest] = parsed.pathname.split('/').filter(Boolean);
    if (!owner || !name || rest.length) return null;
    return key(`${owner}/${name.replace(/\.git$/i, '')}`);
  } catch {
    return null;
  }
}
