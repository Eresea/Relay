import type { Command } from './command';

export const RECENT_COMMANDS_KEY = 'palette.recentCommands';
export const RECENT_COMMAND_LIMIT = 6;

export function updateRecentCommandIds(
  recentIds: readonly string[],
  commandId: string,
  limit = RECENT_COMMAND_LIMIT,
): string[] {
  return [commandId, ...recentIds.filter((id) => id !== commandId)].slice(0, limit);
}

export function recentCommands<T extends Command>(
  commands: readonly T[],
  recentIds: readonly string[],
): readonly T[] {
  const byId = new Map(commands.map((command) => [command.id, command]));
  return recentIds.flatMap((id) => {
    const command = byId.get(id);
    return command ? [command] : [];
  });
}
