import { describe, expect, it } from 'vitest';

import type {
  GithubPullRequestSummary,
  GithubRepositorySummary,
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
});
