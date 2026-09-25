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

  const characters = Array.from(haystack);
  const hay = characters.map((character) => character.toLowerCase());
  const nee = Array.from(needle.toLowerCase());
  const offsets = [0];
  for (const character of characters) offsets.push(offsets.at(-1)! + character.length);

  const scores = Array.from({ length: nee.length }, () =>
    new Array<number>(hay.length).fill(-Infinity),
  );
  const previous = Array.from({ length: nee.length }, () => new Array<number>(hay.length).fill(-1));

  for (let index = 0; index < hay.length; index++) {
    if (hay[index] === nee[0]) {
      scores[0][index] = 1 + (isWordStart(characters, index) ? 8 : 0);
    }
  }

  for (let queryIndex = 1; queryIndex < nee.length; queryIndex++) {
    let bestGapScore = -Infinity;
    let bestGapIndex = -1;
    for (let index = 0; index < hay.length; index++) {
      if (index >= 2 && scores[queryIndex - 1][index - 2] > bestGapScore) {
        bestGapScore = scores[queryIndex - 1][index - 2];
        bestGapIndex = index - 2;
      }
      if (hay[index] !== nee[queryIndex]) continue;

      const adjacentScore = index > 0 ? scores[queryIndex - 1][index - 1] + 6 : -Infinity;
      const gapScore = bestGapScore;
      if (adjacentScore >= gapScore) {
        scores[queryIndex][index] = adjacentScore + 1;
        previous[queryIndex][index] = index - 1;
      } else if (gapScore > -Infinity) {
        scores[queryIndex][index] = gapScore + 1;
        previous[queryIndex][index] = bestGapIndex;
      }
      if (scores[queryIndex][index] > -Infinity && isWordStart(characters, index)) {
        scores[queryIndex][index] += 8;
      }
    }
  }

  let bestIndex = -1;
  const lastScores = scores[nee.length - 1];
  for (let index = 0; index < lastScores.length; index++) {
    if (lastScores[index] > (bestIndex === -1 ? -Infinity : lastScores[bestIndex]))
      bestIndex = index;
  }
  if (bestIndex === -1 || lastScores[bestIndex] === -Infinity) return null;

  const matchedIndices = new Array<number>(nee.length);
  let index = bestIndex;
  for (let queryIndex = nee.length - 1; queryIndex >= 0; queryIndex--) {
    matchedIndices[queryIndex] = index;
    index = previous[queryIndex][index];
  }

  const ranges: [number, number][] = [];
  let start = matchedIndices[0];
  let end = start + 1;
  for (const matchedIndex of matchedIndices.slice(1)) {
    if (matchedIndex === end) {
      end++;
    } else {
      ranges.push([offsets[start], offsets[end]]);
      start = matchedIndex;
      end = start + 1;
    }
  }
  ranges.push([offsets[start], offsets[end]]);

  // Shorter titles that match are usually the better answer.
  return { score: lastScores[bestIndex] - Math.min(haystack.length, 60) * 0.05, ranges };
}

function isWordStart(characters: readonly string[], index: number): boolean {
  return index === 0 || /[\s\-_/.]/.test(characters[index - 1]);
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
