import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationCenter } from '@core/notification-center';
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
    (host.querySelector('.scan-button') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(bridge.setSetting).toHaveBeenCalledWith(
      'projects.scan',
      expect.arrayContaining([
        expect.objectContaining({ path: 'F:/Code/Apps/Relay', icon: 'star' }),
      ]),
    );
  });

  it('notifies when copying project path or github url', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: writeTextMock } });

    const fixture = TestBed.createComponent(Projects);
    fixture.detectChanges();
    await fixture.whenStable();

    const notificationCenter = TestBed.inject(NotificationCenter);
    const component = fixture.componentInstance as unknown as {
      runProjectAction: (project: unknown, action: { id: string }) => void;
    };

    const dummyProject = {
      name: 'Relay',
      path: '/code/relay',
      githubRepo: 'relay/relay',
      githubUrl: 'https://github.com/relay/relay',
      pullRequests: [],
    };

    component.runProjectAction(dummyProject, { id: 'copyPath' });
    expect(writeTextMock).toHaveBeenCalledWith('/code/relay');
    expect(notificationCenter.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Path copied to clipboard',
          detail: '/code/relay',
        }),
      ]),
    );

    component.runProjectAction(dummyProject, { id: 'copyUrl' });
    expect(writeTextMock).toHaveBeenCalledWith('https://github.com/relay/relay');
    expect(notificationCenter.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'GitHub URL copied to clipboard',
          detail: 'https://github.com/relay/relay',
        }),
      ]),
    );

    vi.unstubAllGlobals();
  });
});
