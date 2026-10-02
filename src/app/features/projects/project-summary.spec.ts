import { describe, expect, it } from 'vitest';

import type {
  GithubPullRequestSummary,
  GithubRepositorySummary,
  LinearProject,
  WorkspaceSummary,
} from '@core/tauri';

import { mergeProjectSummaries } from './project-summary';

const workspace = (path: string, githubRepo: string | null): WorkspaceSummary => ({
  name: path.split('/').pop() ?? path,
  path,
  githubRepo,
  modifiedAt: 10,
});

const repository = (fullName: string, pushedAt: string): GithubRepositorySummary => ({
  name: fullName.split('/').pop() ?? fullName,
  fullName,
  htmlUrl: 'https://github.com/' + fullName,
  private: false,
  visibility: 'public',
  sizeKb: 128,
  pushedAt,
  defaultBranch: 'main',
});

const pullRequest = (repository: string): GithubPullRequestSummary => ({
  repository,
  number: 7,
  title: 'Fix the thing',
  url: 'https://github.com/' + repository + '/pull/7',
  state: 'open',
  reviewRequested: true,
  ciState: 'failure',
  lastSeen: 100,
});

describe('mergeProjectSummaries', () => {
  it('joins a local clone to its GitHub repository by owner and name', () => {
    const [project] = mergeProjectSummaries(
      [workspace('F:/Code/relay', 'OpenAI/Relay')],
      [repository('openai/relay', '2026-09-21T10:00:00Z')],
      [pullRequest('openai/relay')],
    );

    expect(project).toMatchObject({
      name: 'relay',
      path: 'F:/Code/relay',
      githubRepo: 'openai/relay',
      sizeKb: 128,
      pullRequests: [pullRequest('openai/relay')],
    });
  });

  it('keeps local-only and remote-only projects visible', () => {
    const projects = mergeProjectSummaries(
      [workspace('F:/Code/local', null)],
      [repository('openai/remote', '2026-09-21T10:00:00Z')],
    );

    expect(projects.map((project) => [project.name, project.path])).toEqual([
      ['remote', null],
      ['local', 'F:/Code/local'],
    ]);
  });

  it('links Linear projects to Relay projects only by an exact GitHub repository URL', () => {
    const linkedProject: LinearProject = {
      id: 'linear-project-1',
      name: 'Relay release',
      description: null,
      url: 'https://linear.app/acme/project/relay-release',
      startDate: null,
      targetDate: null,
      archivedAt: null,
      status: null,
      lead: null,
      teams: [],
      externalLinks: [
        { id: 'link-1', label: 'Renamed label', url: 'https://github.com/OpenAI/Relay' },
        { id: 'link-2', label: 'GitHub: openai/relay', url: 'https://example.com/openai/relay' },
      ],
    };
    const [project] = mergeProjectSummaries(
      [workspace('F:/Code/relay', 'openai/relay')],
      [],
      [],
      [{ ...linkedProject, organizationId: 'org-1', organizationName: 'Acme' }],
    );

    expect(project.linearProjects).toEqual([
      {
        id: 'linear-project-1',
        name: 'Relay release',
        url: 'https://linear.app/acme/project/relay-release',
        organizationId: 'org-1',
        organizationName: 'Acme',
      },
    ]);
  });
});
