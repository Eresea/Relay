import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { ThemeService } from '@/core/theme';
import Home from '@/features/home/home';
import { provide } from '@/lib/inject';
import { signal } from '@/lib/signals';
import { provideBridge } from '@/test/bridge';
import { MODULES, fakeModuleCore } from '@/test/modules';

import { PinWebApp } from './pin-web-app';
import WebAppView from './web-app-view';

it('lays its webview over the tab, hides it when the tab goes, and says why it failed', async () => {
  const bridge = provideBridge({
    available: true,
    webAppsShow: vi
      .fn()
      .mockRejectedValueOnce('Grafana is turned off in Modules')
      .mockResolvedValue(undefined),
    webAppsHide: vi.fn().mockResolvedValue(undefined),
  });
  const { unmount } = render(<WebAppView id="grafana" name="Grafana" />);

  await waitFor(() =>
    expect(bridge.webAppsShow).toHaveBeenCalledWith('grafana', expect.any(Object)),
  );
  expect((await screen.findByRole('alert')).textContent).toBe('Grafana is turned off in Modules');

  unmount();
  expect(bridge.webAppsHide).toHaveBeenCalledWith('grafana');
});

it('pins an address and hands back the new module, or says why not', async () => {
  const core = fakeModuleCore();
  const bridge = provideBridge({
    ...core,
    webAppsPin: vi
      .fn()
      .mockRejectedValueOnce('file:///C: is not a web address')
      .mockResolvedValueOnce({
        id: 'grafana',
        name: 'Grafana',
        url: 'https://grafana.example.com/',
      }),
  });
  const pinned = vi.fn();
  render(<PinWebApp onPinned={pinned} />);

  const address = screen.getByRole('textbox', { name: 'Web address' });
  fireEvent.change(address, { target: { value: 'file:///C:' } });
  fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
  expect((await screen.findByRole('alert')).textContent).toContain('not a web address');

  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Grafana' } });
  fireEvent.change(address, { target: { value: 'grafana.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
  await waitFor(() => expect(pinned).toHaveBeenCalledWith('web-grafana'));
  expect(bridge.webAppsPin).toHaveBeenLastCalledWith('Grafana', 'grafana.example.com');
  expect(core.modulesList).toHaveBeenCalled();
});

it('puts a pinned app on the rail and frees its webview when its tab closes', async () => {
  const grafana = {
    ...MODULES[1],
    id: 'web-grafana',
    name: 'Grafana',
    kind: 'web' as const,
    source: 'pinned' as const,
    surface: { label: 'Grafana', icon: 'globe', rail: true },
    url: 'https://grafana.example.com/',
  };
  const bridge = provideBridge({
    available: false,
    modulesList: vi.fn().mockResolvedValue([...MODULES, grafana]),
    webAppsShow: vi.fn().mockResolvedValue(undefined),
    webAppsHide: vi.fn().mockResolvedValue(undefined),
    webAppsClose: vi.fn().mockResolvedValue(undefined),
  });
  provide(ThemeService, {
    theme: signal('dark'),
    toggle: () => undefined,
  } as unknown as ThemeService);
  render(<Home />);

  fireEvent.click(await screen.findByRole('button', { name: 'Grafana' }));
  await waitFor(() =>
    expect(bridge.webAppsShow).toHaveBeenCalledWith('grafana', expect.any(Object)),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close Grafana' }));
  expect(bridge.webAppsClose).toHaveBeenCalledWith('grafana');
  await waitFor(() => expect(bridge.webAppsHide).toHaveBeenCalledWith('grafana'));
});
