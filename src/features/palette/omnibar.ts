import type { Command, CommandMatch } from '@/core/command';
import { search } from '@/core/fuzzy';
import { recentCommands } from '@/core/recent-commands';

/**
 * The Omnibar's four lenses over the same sources. Do is everything, actions
 * first; the others narrow to one kind of intent.
 */
export type Mode = 'do' | 'ask' | 'find' | 'run';

export const MODES: readonly {
  readonly id: Mode;
  readonly label: string;
  readonly icon: string;
  readonly placeholder: string;
}[] = [
  { id: 'do', label: 'Do', icon: 'command', placeholder: 'Type a command or search' },
  { id: 'ask', label: 'Ask', icon: 'sparkles', placeholder: 'Ask Codex or Claude about a project' },
  { id: 'find', label: 'Find', icon: 'search', placeholder: 'Find a project, thread or update' },
  { id: 'run', label: 'Run', icon: 'terminal', placeholder: 'Run a script or open a terminal' },
];

export type Section = 'Recent' | 'Actions' | 'Ask' | 'Run' | 'Projects' | 'Agents' | 'Activity';

export interface SecondaryAction {
  readonly label: string;
  readonly run: () => unknown;
}

/** One row: a command, plus what its row and the preview pane show. */
export interface OmniResult extends Command {
  readonly section: Exclude<Section, 'Recent'>;
  /** One line of context after the title. */
  readonly sub?: string | undefined;
  /** Right-aligned, in mono: an age, a count. */
  readonly meta?: string | undefined;
  readonly facts?: readonly (readonly [string, string])[];
  /** What happens on Enter, in one sentence. */
  readonly note?: string | undefined;
  /** The Enter action's name in the preview. */
  readonly verb?: string;
  readonly more?: readonly SecondaryAction[];
  /** CSS colour for the tile: the identity hue of the object acted on. */
  readonly tone?: string;
}

export interface OmniMatch extends CommandMatch {
  readonly command: OmniResult;
}

export interface OmniSection {
  readonly section: Section;
  readonly matches: readonly OmniMatch[];
}

export type Sources = Readonly<Record<Exclude<Section, 'Recent'>, readonly OmniResult[]>>;

const VISIBLE: Readonly<Record<Mode, readonly Exclude<Section, 'Recent'>[]>> = {
  do: ['Actions', 'Projects', 'Agents', 'Activity', 'Run'],
  ask: ['Ask', 'Agents'],
  find: ['Projects', 'Agents', 'Activity'],
  run: ['Run'],
};

/** Rows per section when several sections share the list. */
const MIXED_LIMIT = 4;
const ACTIONS_LIMIT = 6;
const SINGLE_LIMIT = 30;
const RECENT_LIMIT = 6;

const asMatch = (command: OmniResult): OmniMatch => ({
  command,
  kind: 'title',
  score: 0,
  ranges: [],
});

/**
 * Groups and ranks results for one mode and query. Ask rows are not searched:
 * their title is the question being typed, so they always match.
 */
export function buildSections(
  mode: Mode,
  query: string,
  sources: Sources,
  recentIds: readonly string[],
): readonly OmniSection[] {
  const typed = query.trim() !== '';

  if (mode === 'do' && !typed) {
    const recent = recentCommands(
      VISIBLE.do.flatMap((section) => sources[section]),
      recentIds,
    ).slice(0, RECENT_LIMIT);
    const seen = new Set(recent.map((r) => r.id));
    return [
      { section: 'Recent' as const, matches: recent.map(asMatch) },
      {
        section: 'Actions' as const,
        matches: sources.Actions.filter((r) => !seen.has(r.id)).map(asMatch),
      },
    ].filter((s) => s.matches.length > 0);
  }

  const visible = VISIBLE[mode];
  const limitFor = (section: Section) =>
    visible.length === 1 ? SINGLE_LIMIT : section === 'Actions' ? ACTIONS_LIMIT : MIXED_LIMIT;

  return visible
    .map((section) => {
      const pool = sources[section];
      const matches = section === 'Ask' || !typed ? pool.map(asMatch) : bySourceOrder(pool, query);
      return { section, matches: matches.slice(0, limitFor(section)) };
    })
    .filter((s) => s.matches.length > 0);
}

/**
 * Fuzzy matches, with near-equal scores in source order. The scorer favours
 * shorter titles by a fraction of a point, which would rank "Leaf" over
 * "Relay" on length alone; sources list the project in context and recent
 * items first, and a near tie should go to them. Real differences in match
 * quality (word starts, adjacent letters) are worth several points.
 */
const TIE = 1;

function bySourceOrder(pool: readonly OmniResult[], query: string): OmniMatch[] {
  const position = new Map(pool.map((result, index) => [result.id, index]));
  const tier = (m: OmniMatch) => (m.kind === 'title' ? 0 : 1);
  return (search(pool, query) as OmniMatch[]).sort(
    (a, b) =>
      tier(a) - tier(b) ||
      (Math.abs(b.score - a.score) >= TIE ? b.score - a.score : 0) ||
      (position.get(a.command.id) ?? 0) - (position.get(b.command.id) ?? 0),
  );
}

/**
 * The rest of `title` when the query is the start of it, shown as ghost text
 * and accepted with the right arrow. Empty when the title does not start with
 * exactly what was typed.
 */
export function completion(query: string, title: string): string {
  if (query === '' || query !== query.trimStart()) return '';
  return title.toLowerCase().startsWith(query.toLowerCase()) ? title.slice(query.length) : '';
}

/** "now", "14m", "3h", "2d", "5mo": an age short enough for a row's meta. */
export function ago(timestampMs: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - timestampMs) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 60 ? `${days}d` : `${Math.floor(days / 30)}mo`;
}

/** The last path segment, for either separator. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
