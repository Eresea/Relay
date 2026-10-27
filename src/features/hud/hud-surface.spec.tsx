import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { NotificationCenter } from '@/core/notification-center';
import { inject } from '@/lib/inject';
import { provideBridge } from '@/test/bridge';

import HudSurface from './hud-surface';

function seed() {
  const center = inject(NotificationCenter);
  center.restore([
    {
      notificationId: 'mail',
      jobId: 'mail',
      hueSource: 'gmail',
      title: 'Luca Ferri',
      status: 'done',
      read: false,
      createdAt: Date.now() - 3_600_000,
    },
  ]);
  center.handle({
    type: 'notification',
    notificationId: 'build',
    jobId: 'build',
    hueSource: '/home/nils/relay',
    title: 'app:build · Relay',
    status: 'running',
    progress: 64,
  });
  center.handle({
    type: 'notification',
    notificationId: 'ask',
    jobId: 'ask',
    hueSource: 'claude',
    title: 'Claude · add a health check',
    detail: 'Run `npm test`',
    status: 'waiting',
    actions: [
      { id: 'allow', label: 'Allow', request: 'approval-1' },
      { id: 'deny', label: 'Deny', request: 'approval-1' },
    ],
  });
}

it('leads with what waits on you, in the pill and in the stack', () => {
  const bridge = provideBridge({
    available: false,
    runNotificationAction: vi.fn().mockResolvedValue(undefined),
  });
  seed();
  render(<HudSurface />);

  // The pill names the ask and who asks, before anything running.
  const pill = screen.getByRole('button', { name: /^Activity: 1 needs you · 1 running/ });
  expect(pill.textContent?.startsWith('Claude · Run npm test')).toBe(true);
  expect(pill.querySelector('code')?.textContent).toBe('npm test');

  fireEvent.click(pill);
  const stack = within(screen.getByRole('region', { name: 'Activity' }));
  const cards = stack.getAllByRole('article');
  expect(cards[0]?.textContent).toContain('Claude · add a health check');
  expect(cards[1]?.textContent).toContain('app:build');
  expect(stack.getByText('1 quiet update')).toBeTruthy();

  fireEvent.click(stack.getByRole('button', { name: 'Allow' }));
  expect(bridge.runNotificationAction).toHaveBeenCalledWith(
    { id: 'allow', label: 'Allow', request: 'approval-1' },
    'ask',
  );
});
