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
  };

  beforeEach(() => {
    bridge.getSetting.mockResolvedValue([]);
    bridge.setSetting.mockResolvedValue(undefined);
    bridge.scanWorkspaces.mockResolvedValue([]);
    bridge.githubRepositories.mockResolvedValue([]);
    bridge.githubPullRequests.mockResolvedValue([]);
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
    (host.querySelector('.scan-button') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(bridge.scanWorkspaces).toHaveBeenCalledOnce();
    expect(bridge.setSetting).toHaveBeenCalledWith(
      'projects.scan',
      expect.arrayContaining([expect.objectContaining({ path: workspace.path })]),
    );
  });
});
