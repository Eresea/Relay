import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { inject } from '@/lib/inject';
import { provideBridge } from '@/test/bridge';

import { UpdateCenter } from './update-center';
import { UpdateStatusBar } from './update-status-bar';

it('keeps update events in one persistent snapshot', () => {
  provideBridge({});
  const center = inject(UpdateCenter);

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

it('installs a ready update from the compact status bar', () => {
  const bridge = provideBridge({ updateInstall: vi.fn().mockResolvedValue(undefined) });
  inject(UpdateCenter).restore({
    state: 'ready',
    currentVersion: '0.1.0',
    version: '0.2.0',
    downloadedBytes: 100,
    contentLength: 100,
  });
  const { container } = render(<UpdateStatusBar />);

  fireEvent.click(container.querySelector('.indicator')!);

  expect(bridge.updateInstall).toHaveBeenCalledOnce();
});
