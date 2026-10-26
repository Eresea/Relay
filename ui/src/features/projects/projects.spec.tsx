import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import type { WorkspaceSummary } from '@/core/tauri';
import { provideBridge } from '@/test/bridge';

import Projects from './projects';

function bridgeWith(overrides: Record<string, unknown> = {}) {
  return provideBridge({
    getSetting: vi.fn().mockResolvedValue([]),
    setSetting: vi.fn().mockResolvedValue(undefined),
    scanWorkspaces: vi.fn().mockResolvedValue([]),
    githubRepositories: vi.fn().mockResolvedValue([]),
    githubPullRequests: vi.fn().mockResolvedValue([]),
    openUrl: vi.fn().mockResolvedValue(undefined),
    linearStatus: vi.fn().mockResolvedValue([]),
    linearProjects: vi.fn().mockResolvedValue([]),
    ...overrides,
  });
}

const savedRelay = {
  name: 'Relay',
  path: 'F:/Code/Apps/Relay',
  githubRepo: null,
  githubUrl: null,
  visibility: null,
  sizeKb: null,
  pushedAt: null,
  modifiedAt: 10,
  pullRequests: [],
};

const syncButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[data-slot="button"]')!;

beforeEach(() => vi.clearAllMocks());

it('restores the saved scan without scanning on initialization', async () => {
  const bridge = bridgeWith({ getSetting: vi.fn().mockResolvedValue([savedRelay]) });

  render(<Projects />);

  await waitFor(() => expect(screen.getAllByText('Relay').length).toBeGreaterThan(0));
  expect(bridge.getSetting).toHaveBeenCalledWith('projects.scan', []);
  expect(bridge.scanWorkspaces).not.toHaveBeenCalled();
});

it('rescans and persists only after the button is pressed', async () => {
  const workspace: WorkspaceSummary = {
    name: 'Relay',
    path: 'F:/Code/Apps/Relay',
    githubRepo: null,
    modifiedAt: 10,
  };
  const bridge = bridgeWith({ scanWorkspaces: vi.fn().mockResolvedValue([workspace]) });
  const { container } = render(<Projects />);
  await waitFor(() => expect(bridge.getSetting).toHaveBeenCalled());
  expect(bridge.scanWorkspaces).not.toHaveBeenCalled();

  fireEvent.click(syncButton(container));

  await waitFor(() =>
    expect(bridge.setSetting).toHaveBeenCalledWith(
      'projects.scan',
      expect.arrayContaining([expect.objectContaining({ path: workspace.path })]),
    ),
  );
  expect(bridge.scanWorkspaces).toHaveBeenCalledOnce();
});

it('shows an explicitly linked Linear project on the matching GitHub-backed Relay project', async () => {
  const repository = {
    name: 'relay',
    fullName: 'openai/relay',
    htmlUrl: 'https://github.com/openai/relay',
    private: true,
    visibility: 'private',
    sizeKb: 128,
    pushedAt: '2026-09-28T10:00:00Z',
    defaultBranch: 'main',
  };
  const bridge = bridgeWith({
    scanWorkspaces: vi
      .fn()
      .mockResolvedValue([
        { name: 'Relay', path: 'F:/Code/relay', githubRepo: 'openai/relay', modifiedAt: 10 },
      ]),
    githubRepositories: vi.fn().mockResolvedValue([repository]),
    linearStatus: vi.fn().mockResolvedValue([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        urlKey: 'acme',
        viewerId: 'viewer-1',
        viewerName: 'Ada',
        viewerEmail: 'ada@example.com',
        agentInstalled: false,
        pausedOnDevice: false,
      },
    ]),
    linearProjects: vi.fn().mockResolvedValue([
      {
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
        externalLinks: [{ id: 'link-1', label: 'GitHub: openai/relay', url: repository.htmlUrl }],
      },
    ]),
  });
  let requested: { organizationId: string; projectId: string } | undefined;
  const { container } = render(
    <Projects onLinearProjectSelected={(request) => (requested = request)} />,
  );
  await waitFor(() => expect(bridge.getSetting).toHaveBeenCalled());

  fireEvent.click(syncButton(container));

  await waitFor(() => expect(container.textContent).toContain('Relay release'));
  expect(bridge.setSetting).toHaveBeenCalledWith(
    'projects.scan',
    expect.arrayContaining([
      expect.objectContaining({
        githubRepo: 'openai/relay',
        linearProjects: [
          expect.objectContaining({ organizationName: 'Acme', name: 'Relay release' }),
        ],
      }),
    ]),
  );

  fireEvent.click(container.querySelector('.linear-project-link')!);
  expect(requested).toEqual({ organizationId: 'org-1', projectId: 'linear-project-1' });
  expect(bridge.openUrl).not.toHaveBeenCalled();
});

it('keeps a custom icon when the project is rescanned', async () => {
  const bridge = bridgeWith({
    getSetting: vi.fn().mockResolvedValue([{ ...savedRelay, icon: 'star' }]),
    scanWorkspaces: vi
      .fn()
      .mockResolvedValue([
        { name: 'Relay', path: 'F:/Code/Apps/Relay', githubRepo: null, modifiedAt: 12 },
      ]),
  });
  const { container } = render(<Projects />);
  await waitFor(() => expect(screen.getAllByText('Relay').length).toBeGreaterThan(0));

  fireEvent.click(syncButton(container));

  await waitFor(() =>
    expect(bridge.setSetting).toHaveBeenCalledWith(
      'projects.scan',
      expect.arrayContaining([
        expect.objectContaining({ path: 'F:/Code/Apps/Relay', icon: 'star' }),
      ]),
    ),
  );
});
