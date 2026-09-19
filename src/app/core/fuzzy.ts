import type { Command, CommandMatch } from './command';

/**
 * Subsequence match with a bias towards word starts and runs.
 *
 * Deliberately small: a palette over a few hundred commands does not need a
 * full fuzzy-finder, and a scoring function you can read is worth more than one
 * that ranks marginally better.
 */
interface Scored {
  readonly score: number;
  readonly ranges: [number, number][];
}

function scoreOne(haystack: string, needle: string): Scored | null {
  if (needle.length === 0) return { score: 0, ranges: [] };

  const hay = haystack.toLowerCase();
  const nee = needle.toLowerCase();

  const ranges: [number, number][] = [];
  let score = 0;
  let from = 0;
  let runStart = -1;
  let previousIndex = -2;

  for (const character of nee) {
    const index = hay.indexOf(character, from);
    if (index === -1) return null;

    if (index === 0 || /[\s\-_/.]/.test(hay[index - 1])) score += 8;
    if (index === previousIndex + 1) {
      score += 6;
    } else {
      if (runStart !== -1) ranges.push([runStart, previousIndex + 1]);
      runStart = index;
    }
    score += 1;

    previousIndex = index;
    from = index + 1;
  }

  if (runStart !== -1) ranges.push([runStart, previousIndex + 1]);

  // Shorter titles that match are usually the better answer.
  score -= Math.min(haystack.length, 60) * 0.05;
  return { score, ranges };
}

/** Title matches first, then keyword matches; within a tier, by score. */
const TIER = { title: 0, keyword: 1 } as const;

export function search(commands: readonly Command[], query: string): CommandMatch[] {
  const trimmed = query.trim();
  if (trimmed === '') {
    return commands.map((command) => ({
      command,
      kind: 'title' as const,
      score: 0,
      ranges: [],
    }));
  }

  const matches: CommandMatch[] = [];

  for (const command of commands) {
    const onTitle = scoreOne(command.title, trimmed);
    if (onTitle) {
      matches.push({ command, kind: 'title', score: onTitle.score, ranges: onTitle.ranges });
      continue;
    }

    // The group and any keywords are searchable, but the user cannot see them
    // on the row, so they never outrank a visible title match.
    const best = [command.group, ...(command.keywords ?? [])]
      .map((text) => scoreOne(text, trimmed))
      .filter((scored): scored is Scored => scored !== null)
      .sort((a, b) => b.score - a.score)[0];

    if (best) matches.push({ command, kind: 'keyword', score: best.score, ranges: [] });
  }

  return matches.sort(
    (a, b) =>
      TIER[a.kind] - TIER[b.kind] ||
      b.score - a.score ||
      a.command.title.localeCompare(b.command.title),
  );
}
