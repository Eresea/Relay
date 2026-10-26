import { describe, expect, it } from 'vitest';

import type { Command } from './command';
import { search } from './fuzzy';

function command(id: string, title: string, extra: Partial<Command> = {}): Command {
  return { id, title, group: 'Relay', run: () => undefined, ...extra };
}

const commands: readonly Command[] = [
  command('a', 'Open project'),
  command('b', 'Open settings'),
  command('c', 'Toggle theme', { group: 'Appearance', keywords: ['dark', 'light'] }),
  command('d', 'Quit Relay'),
];

describe('search', () => {
  it('returns every command, in order, for an empty query', () => {
    expect(search(commands, '  ').map((m) => m.command.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('matches a subsequence rather than only a prefix', () => {
    expect(search(commands, 'opj').map((m) => m.command.id)).toEqual(['a']);
  });

  it('is case insensitive', () => {
    expect(search(commands, 'QUIT')[0]?.command.id).toBe('d');
  });

  it('ranks a consecutive run above a scattered match', () => {
    expect(search(commands, 'set')[0]?.command.id).toBe('b');
  });

  it('matches on keywords the row does not show', () => {
    const [match] = search(commands, 'dark');
    expect(match?.command.id).toBe('c');
    expect(match?.kind).toBe('keyword');
  });

  it('puts every title match above every keyword match', () => {
    // 'e' appears in three titles and in the keyword "theme"/"Appearance".
    const results = search(commands, 'e');
    const firstKeyword = results.findIndex((m) => m.kind === 'keyword');
    const lastTitle = results.map((m) => m.kind).lastIndexOf('title');

    expect(firstKeyword === -1 || lastTitle < firstKeyword).toBe(true);
  });

  it('does not rank a long keyword match above a short title match', () => {
    const short = command('short', 'Zip', { keywords: [] });
    const keyworded = command('kw', 'Something else entirely', {
      keywords: ['zip archive compression'],
    });

    const ranked = search([keyworded, short], 'zip');
    expect(ranked.map((m) => m.command.id)).toEqual(['short', 'kw']);
  });

  it('drops commands that do not match at all', () => {
    expect(search(commands, 'zzz')).toEqual([]);
  });

  it('reports ranges that cover the matched characters', () => {
    const [match] = search(commands, 'open');
    expect(match?.ranges).toEqual([[0, 4]]);
  });
});
