import type {
  ClaudeSession,
  ClaudeSessionSummary,
  CodexThread,
  CodexThreadItem,
  CodexThreadSummary,
  ModelChoice,
  TauriBridge,
} from '@/core/tauri';
import { codexThreadPreview, codexThreadTitle } from '@/core/tauri';

/**
 * One conversation model for both agents. Codex threads and Claude Code
 * sessions are read differently by the core; the Agents tab only ever sees
 * these shapes.
 */
export type Agent = 'codex' | 'claude';

export const AGENTS: Readonly<Record<Agent, { label: string; icon: string }>> = {
  codex: { label: 'Codex', icon: 'sparkles' },
  claude: { label: 'Claude', icon: 'bot' },
};

export interface ChatSummary {
  readonly agent: Agent;
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  /** Milliseconds since the epoch. */
  readonly updatedAt: number;
  readonly model: string | null;
  readonly branch: string | null;
  /** "owner/name" on GitHub, when the agent knows the origin; Codex only. */
  readonly repository: string | null;
  /** What Relay's own turns cost; Claude only. */
  readonly spend: { readonly usd: number; readonly turns: number } | null;
}

/** A step of a conversation. `detail` is what a tool step can show on demand. */
export interface ChatEntry {
  readonly kind: 'user' | 'assistant' | 'thinking' | 'tool';
  readonly text: string;
  readonly detail?: string | undefined;
}

export interface Chat extends ChatSummary {
  readonly entries: readonly ChatEntry[];
  readonly effort: string | null;
}

/** "$0.43", or "under $0.01" rather than a misleading "$0.00". Mirrors claude::format_usd. */
export const formatUsd = (usd: number) => (usd < 0.01 ? 'under $0.01' : `$${usd.toFixed(2)}`);

export function fromClaudeSummary(session: ClaudeSessionSummary): ChatSummary {
  return {
    agent: 'claude',
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    updatedAt: session.updatedAt * 1000,
    model: null,
    branch: null,
    repository: null,
    spend: session.spend,
  };
}

export function fromClaude(session: ClaudeSession): Chat {
  return {
    ...fromClaudeSummary(session),
    model: session.model,
    effort: null,
    entries: session.messages.map((m) => ({ kind: m.role, text: m.text })),
  };
}

export function fromCodexSummary(thread: CodexThreadSummary): ChatSummary {
  return {
    agent: 'codex',
    id: thread.id,
    title: codexThreadTitle(thread),
    cwd: thread.cwd,
    updatedAt: (thread.recencyAt ?? thread.updatedAt ?? thread.createdAt) * 1000,
    model: thread.model,
    branch: thread.gitInfo?.branch ?? null,
    repository: repositoryName(thread.gitInfo?.originUrl),
    spend: null,
  };
}

export function fromCodex(thread: CodexThread): Chat {
  return {
    ...fromCodexSummary(thread),
    effort: thread.reasoningEffort ?? null,
    entries: thread.turns.flatMap((turn) => turn.items.flatMap(codexEntries)),
  };
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const texts = (value: unknown) =>
  (Array.isArray(value) ? value : [])
    .map(text)
    .filter((t) => t.trim())
    .join('\n\n');
const json = (value: unknown) => JSON.stringify(value, null, 2) ?? '';

const ITEM_TITLES: Readonly<Record<string, string>> = {
  mcpToolCall: 'MCP tool call',
  dynamicToolCall: 'Tool call',
  webSearch: 'Web search',
  imageView: 'Image',
  imageGeneration: 'Image generation',
  collabAgentToolCall: 'Agent handoff',
  subAgentActivity: 'Subagent activity',
  contextCompaction: 'Context compacted',
  enteredReviewMode: 'Review started',
  exitedReviewMode: 'Review finished',
  functionCallOutput: 'Function output',
  hookPrompt: 'Hook prompt',
  sleep: 'Wait',
};

/** A Codex thread item as chat entries: none for empty reasoning. */
export function codexEntries(item: CodexThreadItem): ChatEntry[] {
  switch (item.type) {
    case 'userMessage': {
      const content = Array.isArray(item['content']) ? (item['content'] as unknown[]) : [];
      return content.flatMap((block): ChatEntry[] => {
        const b = (block ?? {}) as Record<string, unknown>;
        if (b['type'] === 'text') {
          const said = text(b['text']);
          // Text that is only Codex's own context wrappers is not something you said.
          return codexThreadPreview(said) ? [{ kind: 'user', text: said.trim() }] : [];
        }
        const where = text(b['path'] ?? b['url'] ?? b['name']);
        return [
          { kind: 'tool', text: `${text(b['type']) || 'Attachment'}${where && ` · ${where}`}` },
        ];
      });
    }
    case 'agentMessage':
    case 'plan':
      return text(item['text']).trim() ? [{ kind: 'assistant', text: text(item['text']) }] : [];
    case 'reasoning': {
      const said = texts(item['summary']) || texts(item['content']);
      return said ? [{ kind: 'thinking', text: said }] : [];
    }
    case 'commandExecution':
      return [
        {
          kind: 'tool',
          text: `Run \`${text(item['command'])}\``,
          detail: text(item['aggregatedOutput']) || undefined,
        },
      ];
    case 'fileChange': {
      const changes = (Array.isArray(item['changes']) ? item['changes'] : []) as {
        path?: string;
        diff?: string;
      }[];
      return [
        {
          kind: 'tool',
          text: `Edit ${changes.map((c) => c.path).join(', ') || 'files'}`,
          detail: changes.map((c) => c.diff ?? '').join('\n') || undefined,
        },
      ];
    }
    default:
      return [{ kind: 'tool', text: ITEM_TITLES[item.type] ?? item.type, detail: json(item) }];
  }
}

/** Runs of tool steps fold into one row, so the conversation reads as one. */
export function steps(
  entries: readonly ChatEntry[],
): (ChatEntry | { readonly kind: 'steps'; readonly entries: ChatEntry[] })[] {
  const out: (ChatEntry | { kind: 'steps'; entries: ChatEntry[] })[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    if (entry.kind !== 'tool') out.push(entry);
    else if (last?.kind === 'steps') last.entries.push(entry);
    else out.push({ kind: 'steps', entries: [entry] });
  }
  return out;
}

function repositoryName(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin.replace(/^git@github\.com:/i, 'https://github.com/'));
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const repository = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return /^[^/]+\/[^/]+$/.test(repository) ? repository : null;
  } catch {
    return null;
  }
}

/** Both agents' conversations, newest first. */
export function merge(...lists: readonly (readonly ChatSummary[])[]): ChatSummary[] {
  return lists.flat().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Claude Code takes an alias for the latest of a family, or a full id. */
export const CLAUDE_MODELS: readonly { readonly id: string; readonly name: string }[] = [
  { id: 'opus', name: 'Opus' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' },
  { id: 'fable', name: 'Fable' },
];

/** `claude --effort` levels, mirroring claude::EFFORTS. */
export const CLAUDE_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const effortLabel = (effort: string) =>
  effort === 'xhigh' ? 'Extra high' : effort.charAt(0).toUpperCase() + effort.slice(1);

/** The last agent, model and effort you picked, shared with the Omnibar's Ask. */
export interface Choices {
  readonly agent: Agent;
  readonly codex: ModelChoice;
  readonly claude: ModelChoice;
}

const CHOICES_KEY = 'agents.choice';
const NO_CHOICE: ModelChoice = { model: null, effort: null };
export const DEFAULT_CHOICES: Choices = { agent: 'claude', codex: NO_CHOICE, claude: NO_CHOICE };

export async function loadChoices(tauri: TauriBridge): Promise<Choices> {
  const stored = await tauri.getSetting<Partial<Choices> | null>(CHOICES_KEY, null);
  return { ...DEFAULT_CHOICES, ...stored };
}

export function saveChoices(tauri: TauriBridge, choices: Choices): Promise<void> {
  return tauri.setSetting(CHOICES_KEY, choices);
}

/** The job's "Open" link names the conversation a new turn started. */
export function chatFromLink(url: string): { agent: Agent; id: string } | null {
  const match = /^relay:\/\/(codex|claude)\/([\w-]+)$/.exec(url);
  return match ? { agent: match[1] as Agent, id: match[2] } : null;
}
