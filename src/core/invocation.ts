/**
 * The palette's input grammar. Commands remain fuzzy-searchable; an `@` at
 * the start reserves the input for an agent prompt.
 */
export type Invocation =
  | { readonly kind: 'command'; readonly query: string }
  | {
      readonly kind: 'agent';
      /** Lower-case canonical id when a complete mention is present. */
      readonly agentId: string | null;
      /** Text after `@`, useful for agent autocomplete. */
      readonly agentQuery: string;
      /** Null until the mention is followed by whitespace and prompt text. */
      readonly prompt: string | null;
    };

const AGENT_ID = /^[a-z0-9][a-z0-9._-]*$/i;

/** Parses palette input without dispatching commands or producing side effects. */
export function parseInvocation(input: string): Invocation {
  const query = input.trimStart();
  if (!query.startsWith('@')) return { kind: 'command', query: input };

  const rest = query.slice(1);
  const separator = rest.search(/\s/);
  const rawId = separator === -1 ? rest : rest.slice(0, separator);
  if (rawId !== '' && !AGENT_ID.test(rawId)) {
    return { kind: 'command', query: input };
  }

  const prompt = separator === -1 ? null : rest.slice(separator).trim();
  return {
    kind: 'agent',
    agentId: rawId === '' ? null : rawId.toLowerCase(),
    agentQuery: rawId.toLowerCase(),
    prompt: prompt === '' ? null : prompt,
  };
}
