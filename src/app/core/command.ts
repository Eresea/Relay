import type { EntityHue } from './entity-hue';

/** What a command does when the user picks it. */
export type CommandRun = () => void | Promise<void>;

/**
 * One entry in the palette. Commands are contributed by feature modules and by
 * the Rust side; the palette itself knows nothing about where they came from.
 */
export interface Command {
  readonly id: string;
  /** Sentence case, names the action not the assent: "Open project", not "OK". */
  readonly title: string;
  /** Search category; command rows stay title-only. */
  readonly group: string;
  /** Lucide glyph name. */
  readonly icon?: string;
  /** Identity hue, for commands that act on a specific long-lived object. */
  readonly hue?: EntityHue;
  /** Displayed as keycaps, e.g. ['Ctrl', 'Shift', 'P']. */
  readonly shortcut?: readonly string[];
  /** Extra words to match on that are not in the title. */
  readonly keywords?: readonly string[];
  readonly run: CommandRun;
}

/**
 * What the query matched. `title` always outranks `keyword`, whatever the
 * scores: a command the user can see the name of should not be pushed below one
 * that matched on a word they cannot.
 */
export type MatchKind = 'title' | 'keyword';

export interface CommandMatch {
  readonly command: Command;
  readonly kind: MatchKind;
  readonly score: number;
  /** Index pairs in the title that matched, for highlighting. */
  readonly ranges: readonly [number, number][];
}
