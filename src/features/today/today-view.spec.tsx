import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { NotificationCenter } from '@/core/notification-center';
import { inject } from '@/lib/inject';
import { provideBridge } from '@/test/bridge';

import Today from './today-view';

it('triages live and quiet items and acts on the selected one', () => {
  const bridge = provideBridge({
    available: false,
    openUrl: vi.fn().mockResolvedValue(undefined),
    notificationsMarkRead: vi.fn().mockResolvedValue(undefined),
  });
  const center = inject(NotificationCenter);
  center.restore([
    {
      notificationId: 'mail',
      jobId: 'mail',
      hueSource: 'gmail',
      title: 'Play Console key ready',
      status: 'done',
      read: false,
      createdAt: Date.now() - 3_600_000,
    },
  ]);
  center.handle({
    type: 'notification',
    notificationId: 'pr',
    jobId: 'pr',
    hueSource: 'github',
    title: 'Review requested on #37',
    status: 'waiting',
    actions: [{ id: 'open', label: 'Open PR', url: 'https://github.com/x/y/pull/37' }],
  });
  center.handle({
    type: 'notification',
    notificationId: 'build',
    jobId: 'build',
    hueSource: '/home/nils/relay',
    title: 'app:build',
    status: 'running',
    progress: 40,
  });

  render(<Today />);

  const group = (name: string) => within(screen.getByRole('region', { name }));
  expect(group('Needs you').getByText('Review requested on #37')).toBeTruthy();
  expect(group('Happening').getByText('app:build')).toBeTruthy();
  expect(group('Quiet').getByText('Play Console key ready')).toBeTruthy();

  // The first item that needs you is selected; its action runs from the detail pane.
  const detail = within(screen.getByRole('article', { name: 'Selected item' }));
  fireEvent.click(detail.getByRole('button', { name: 'Open PR' }));
  expect(bridge.openUrl).toHaveBeenCalledWith('https://github.com/x/y/pull/37');
  expect(bridge.notificationsMarkRead).toHaveBeenCalledWith(['pr']);

  fireEvent.click(screen.getByRole('button', { name: /^Mail · 1/ }));
  expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
  expect(group('Quiet').getByText('Play Console key ready')).toBeTruthy();
});
