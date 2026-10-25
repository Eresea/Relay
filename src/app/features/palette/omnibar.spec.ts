import { describe, expect, it } from 'vitest';

import {
  ago,
  buildSections,
  completion,
  folderName,
  type OmniResult,
  type Sources,
} from './omnibar';

function result(section: OmniResult['section'], id: string, title = id): OmniResult {
  return { id, title, section, group: section, run: () => undefined };
}

function sources(partial: Partial<Sources>): Sources {
  return { Actions: [], Ask: [], Run: [], Projects: [], Agents: [], Activity: [], ...partial };
}

const titles = (sections: ReturnType<typeof buildSections>) =>
  sections.map((s) => [s.section, s.matches.map((m) => m.command.title)]);

describe('buildSections', () => {
  const all = sources({
    Actions: [
      result('Actions', 'release', 'Release Relay'),
      result('Actions', 'theme', 'Toggle theme'),
    ],
    Run: [result('Run', 'build', 'Run build · Relay')],
    Projects: [result('Projects', 'relay', 'Relay'), result('Projects', 'leaf', 'Leaf')],
    Agents: [result('Agents', 'thread', 'Open vault sync tests')],
    Activity: [result('Activity', 'pr', '#36 merged into main')],
    Ask: [result('Ask', 'ask', 'why is the build slow')],
  });

  it('shows recents, then the remaining actions, for an empty Do query', () => {
    expect(titles(buildSections('do', '', all, ['leaf', 'missing', 'theme']))).toEqual([
      ['Recent', ['Leaf', 'Toggle theme']],
      ['Actions', ['Release Relay']],
    ]);
  });

  it('searches every source in Do, grouped, actions first', () => {
    expect(titles(buildSections('do', 'rel', all, []))).toEqual([
      ['Actions', ['Release Relay']],
      ['Projects', ['Relay']],
      ['Run', ['Run build · Relay']],
    ]);
  });

  it('breaks ties in source order, so the project in context wins', () => {
    const run = sources({
      Run: [result('Run', 'relay', 'Run build · Relay'), result('Run', 'leaf', 'Run build · Leaf')],
    });
    expect(titles(buildSections('run', 'build', run, []))).toEqual([
      ['Run', ['Run build · Relay', 'Run build · Leaf']],
    ]);
  });

  it('narrows to one kind of result per mode', () => {
    expect(buildSections('find', 'rel', all, []).map((s) => s.section)).toEqual(['Projects']);
    expect(buildSections('run', '', all, []).map((s) => s.section)).toEqual(['Run']);
  });

  it('never searches Ask rows: their title is the question', () => {
    expect(titles(buildSections('ask', 'zzz', all, []))).toEqual([
      ['Ask', ['why is the build slow']],
    ]);
  });

  it('limits shared sections but not a single-section mode', () => {
    const many = sources({
      Projects: Array.from({ length: 10 }, (_, i) => result('Projects', `p${i}`, `Project ${i}`)),
    });
    expect(buildSections('find', 'project', many, [])[0]?.matches).toHaveLength(4);
    const run = sources({
      Run: Array.from({ length: 10 }, (_, i) => result('Run', `r${i}`, `Run s${i}`)),
    });
    expect(buildSections('run', 'run', run, [])[0]?.matches).toHaveLength(10);
  });
});

describe('completion', () => {
  it('completes a title the query starts, case-insensitively', () => {
    expect(completion('rel', 'Release Relay')).toBe('ease Relay');
  });

  it('offers nothing when the title does not start with the query', () => {
    expect(completion('relay', 'Release Relay')).toBe('');
    expect(completion('', 'Release Relay')).toBe('');
    expect(completion(' rel', 'Release Relay')).toBe('');
  });
});

describe('ago', () => {
  const now = Date.UTC(2026, 9, 25, 12);
  it('is short and specific', () => {
    expect(ago(now - 20_000, now)).toBe('now');
    expect(ago(now - 14 * 60_000, now)).toBe('14m');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3h');
    expect(ago(now - 2 * 86_400_000, now)).toBe('2d');
    expect(ago(now - 150 * 86_400_000, now)).toBe('5mo');
  });
});

describe('folderName', () => {
  it('takes the last segment of either kind of path', () => {
    expect(folderName('F:\\Code\\Apps\\Relay')).toBe('Relay');
    expect(folderName('/home/nils/leaf/')).toBe('leaf');
  });
});
