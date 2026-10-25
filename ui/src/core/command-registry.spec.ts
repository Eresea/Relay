import { describe, beforeEach, expect, it } from 'vitest';

import type { Command } from './command';
import { CommandRegistry } from './command-registry';

function command(id: string): Command {
  return { id, title: id, group: 'Relay', run: () => undefined };
}

describe('CommandRegistry', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  it('starts empty', () => {
    expect(registry.commands()).toEqual([]);
  });

  it('exposes registered commands and finds them by id', () => {
    registry.register(command('one'), command('two'));
    expect(registry.commands()).toHaveLength(2);
    expect(registry.byId('two')?.id).toBe('two');
  });

  it('removes exactly the commands a disposer owns', () => {
    registry.register(command('kept'));
    const dispose = registry.register(command('temporary'));

    dispose();

    expect(registry.commands().map((c) => c.id)).toEqual(['kept']);
  });

  it('rejects a duplicate id rather than shadowing the original', () => {
    registry.register(command('one'));
    expect(() => registry.register(command('one'))).toThrow(/already registered/);
  });

  it('leaves the registry unchanged when a batch is rejected', () => {
    registry.register(command('one'));
    expect(() => registry.register(command('two'), command('one'))).toThrow();
    expect(registry.commands().map((c) => c.id)).toEqual(['one']);
  });
});
