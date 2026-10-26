import { expect, it, vi } from 'vitest';

import { inject } from '@/lib/inject';
import { provideBridge } from '@/test/bridge';

import { BUILT_IN_MODULES, ModuleRegistry } from './modules';

it('turns modules off and back on, but never a core one', async () => {
  const bridge = provideBridge({
    available: true,
    getSetting: vi.fn().mockResolvedValue(['vault', 'not-a-module', 3]),
    setSetting: vi.fn().mockResolvedValue(undefined),
  });
  const modules = inject(ModuleRegistry);
  await modules.load();

  expect(modules.isEnabled('vault')).toBe(false);
  expect(modules.isEnabled('codex')).toBe(true);
  expect(modules.isEnabled('missing')).toBe(false);
  // A command belongs to its module; one no module claims is always there.
  expect(modules.commandEnabled('relay.vault.open')).toBe(false);
  expect(modules.commandEnabled('relay.theme.toggle')).toBe(true);

  modules.setEnabled('settings', false);
  expect(modules.isEnabled('settings')).toBe(true);

  modules.setEnabled('vault', true);
  modules.setEnabled('gmail', false);
  expect(bridge.setSetting).toHaveBeenLastCalledWith('modules.off', ['not-a-module', 'gmail']);
  expect(modules.enabled().map((m) => m.id)).not.toContain('gmail');
});

it('gives every built-in module a unique id and owns each command once', () => {
  const ids = BUILT_IN_MODULES.map((m) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
  const commands = BUILT_IN_MODULES.flatMap((m) => m.commands);
  expect(new Set(commands).size).toBe(commands.length);
});
