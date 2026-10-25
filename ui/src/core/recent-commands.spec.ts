import { describe, expect, it } from 'vitest';

import type { Command } from './command';
import { recentCommands, updateRecentCommandIds } from './recent-commands';

function command(id: string): Command {
  return { id, title: id, group: 'Test', run: () => undefined };
}

describe('recent commands', () => {
  it('moves the selected command to the front and removes duplicates', () => {
    expect(updateRecentCommandIds(['two', 'one'], 'one')).toEqual(['one', 'two']);
  });

  it('keeps only commands that still exist', () => {
    expect(recentCommands([command('one')], ['missing', 'one']).map((item) => item.id)).toEqual([
      'one',
    ]);
  });
});
