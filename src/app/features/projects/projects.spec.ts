import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TauriBridge, type WorkspaceSummary } from '@core/tauri';

import { Projects } from './projects';

describe('Projects', () => {
  const bridge = {
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    scanWorkspaces: vi.fn(),
    githubRepositories: vi.fn(),
    githubPullRequests: vi.fn(),
    linearStatus: vi.fn(),
    linearProjects: vi.fn(),
  };

  beforeEach(() => {
    bridge.getSetting.mockResolvedValue([]);
    bridge.setSetting.mockResolvedValue(undefined);
    bridge.scanWorkspaces.mockResolvedValue([]);
    bridge.githubRepositories.mockResolvedValue([]);
    bridge.githubPullRequests.mockResolvedValue([]);
    bridge.linearStatus.mockResolvedValue([]);
    bridge.linearProjects.mockResolvedValue([]);
    TestBed.configureTestingModule({
      providers: [{ provide: TauriBridge, useValue: bridge }],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('restores the saved scan without scanning on initialization', async () => {
    bridge.getSetting.mockResolvedValue([
      {
        name: 'Relay',
        path: 'F:/Code/Apps/Relay',
        githubRepo: null,
        githubUrl: null,
        visibility: null,
        sizeKb: null,
        pushedAt: null,
        modifiedAt: 10,
        pullRequests: [],
      },
    ]);

    const fixture = TestBed.createComponent(Projects);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(bridge.getSetting).toHaveBeenCalledWith('projects.scan', []);
    expect(bridge.scanWorkspaces).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Relay');
  });

  it('rescans and persists only after the button is pressed', async () => {
    const workspace: WorkspaceSummary = {
      name: 'Relay',
      path: 'F:/Code/Apps/Relay',
      githubRepo: null,
      modifiedAt: 10,
    };
    bridge.scanWorkspaces.mockResolvedValue([workspace]);

    const fixture = TestBed.createComponent(Projects);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    host.querySelector('umbra-button')!.dispatchEvent(new Event('click'));
    await fixture.whenStable();

    expect(bridge.scanWorkspaces).toHaveBeenCalledOnce();
    expect(bridge.setSetting).toHaveBeenCalledWith(
      'projects.scan',
      expect.arrayContaining([expect.objectContaining({ path: workspace.path })]),
    );
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
    bridge.scanWorkspaces.mockResolvedValue([
      { name: 'Relay', path: 'F:/Code/relay', githubRepo: 'openai/relay', modifiedAt: 10 },
    ]);
    bridge.githubRepositories.mockResolvedValue([repository]);
    bridge.linearStatus.mockResolvedValue([
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
    ]);
    bridge.linearProjects.mockResolvedValue([
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
    ]);

    const fixture = TestBed.createComponent(Projects);
    fixture.detectChanges();
    await fixture.whenStable();
    (fixture.nativeElement as HTMLElement)
      .querySelector('umbra-button')!
      .dispatchEvent(new Event('click'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Relay release');
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
  });

  it('keeps a custom icon when the project is rescanned', async () => {
    bridge.getSetting.mockResolvedValue([
      {
        name: 'Relay',
        path: 'F:/Code/Apps/Relay',
        icon: 'star',
        githubRepo: null,
        githubUrl: null,
        visibility: null,
        sizeKb: null,
        pushedAt: null,
        modifiedAt: 10,
        pullRequests: [],
      },
    ]);
    bridge.scanWorkspaces.mockResolvedValue([
      {
        name: 'Relay',
        path: 'F:/Code/Apps/Relay',
        githubRepo: null,
        modifiedAt: 12,
      },
    ]);

    const fixture = TestBed.createComponent(Projects);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector('umbra-button')!.dispatchEvent(new Event('click'));
    await fixture.whenStable();

    expect(bridge.setSetting).toHaveBeenCalledWith(
      'projects.scan',
      expect.arrayContaining([
        expect.objectContaining({ path: 'F:/Code/Apps/Relay', icon: 'star' }),
      ]),
    );
  });
});
