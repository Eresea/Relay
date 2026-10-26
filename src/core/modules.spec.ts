import { expect, it } from 'vitest';

import { inject } from '@/lib/inject';
import { provideBridge } from '@/test/bridge';
import { fakeModuleCore } from '@/test/modules';

import { ModuleRegistry } from './modules';

it('draws from the core and settles a change on what the core says', async () => {
  const core = fakeModuleCore(['vault']);
  provideBridge(core);
  const modules = inject(ModuleRegistry);
  await modules.load();

  expect(modules.isEnabled('vault')).toBe(false);
  expect(modules.isEnabled('codex')).toBe(true);
  expect(modules.isEnabled('missing')).toBe(false);
  // A command belongs to its module; one no module claims is always there.
  expect(modules.commandEnabled('relay.vault.open')).toBe(false);
  expect(modules.commandEnabled('relay.theme.toggle')).toBe(true);

  await modules.setEnabled('vault', true);
  expect(core.modulesSetEnabled).toHaveBeenCalledWith('vault', true);
  expect(modules.isEnabled('vault')).toBe(true);

  // The core refused: the registry goes back to what the core has.
  core.modulesSetEnabled.mockRejectedValueOnce('Settings is part of Relay');
  await expect(modules.setEnabled('settings', false)).rejects.toBe('Settings is part of Relay');
  expect(modules.isEnabled('settings')).toBe(true);
});
