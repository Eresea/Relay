import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TauriBridge } from '@core/tauri';

import { UpdateCenter, UpdateStatusBar } from './update-center';

describe('UpdateCenter', () => {
  const bridge = {
    updateStatus: vi.fn(),
    updateCheck: vi.fn(),
    updateDownload: vi.fn(),
    updateInstall: vi.fn(),
  };

  beforeEach(() => {
    bridge.updateStatus.mockResolvedValue({
      state: 'idle',
      currentVersion: '0.1.0',
      downloadedBytes: 0,
    });
    bridge.updateCheck.mockResolvedValue(undefined);
    bridge.updateDownload.mockResolvedValue(undefined);
    bridge.updateInstall.mockResolvedValue(undefined);
    TestBed.configureTestingModule({ providers: [{ provide: TauriBridge, useValue: bridge }] });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('keeps update events in one persistent snapshot', () => {
    const center = TestBed.inject(UpdateCenter);

    center.handle({
      type: 'updateChanged',
      state: 'downloading',
      currentVersion: '0.1.0',
      version: '0.2.0',
      downloadedBytes: 50,
      contentLength: 100,
    });

    expect(center.snapshot()).toEqual(
      expect.objectContaining({ state: 'downloading', downloadedBytes: 50 }),
    );
  });

  it('installs a ready update from the compact status bar', async () => {
    const center = TestBed.inject(UpdateCenter);
    center.restore({
      state: 'ready',
      currentVersion: '0.1.0',
      version: '0.2.0',
      downloadedBytes: 100,
      contentLength: 100,
    });
    const fixture = TestBed.createComponent(UpdateStatusBar);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    (host.querySelector('.action') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(bridge.updateInstall).toHaveBeenCalledOnce();
  });
});
