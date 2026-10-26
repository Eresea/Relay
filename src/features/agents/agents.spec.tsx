import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import type { AppEvent } from '@/core/events';
import {
  codexThreadPreview,
  codexThreadTitle,
  type ClaudeSession,
  type CodexThreadDetails,
} from '@/core/tauri';
import { provideBridge } from '@/test/bridge';

import Agents from './agents';
import { chatFromLink, codexEntries, formatUsd, steps } from './chat';

const now = Math.floor(Date.now() / 1000);

const session = (replies: string[] = [], spend: ClaudeSession['spend'] = null): ClaudeSession => ({
  id: 'a1',
  title: 'Why is the probe failing?',
  cwd: '/home/nils/leaf',
  updatedAt: now,
  spend,
  model: 'claude-opus-5-5',
  messages: [
    { role: 'user', text: 'Why is the probe failing?', timestamp: null },
    { role: 'thinking', text: 'Check the token first.', timestamp: null },
    { role: 'tool', text: 'Read probe.rs', timestamp: null },
    { role: 'tool', text: 'Run `npm test`', timestamp: null },
    ...replies.map((text) => ({ role: 'assistant' as const, text, timestamp: null })),
  ],
});

const thread: CodexThreadDetails = {
  thread: {
    id: 't1',
    name: 'Fix the vault',
    preview: 'Fix the vault',
    cwd: '/home/nils/relay',
    createdAt: now - 7200,
    updatedAt: now - 7200,
    recencyAt: null,
    model: 'gpt-6-astra',
    reasoningEffort: 'high',
    turns: [
      {
        id: 'turn',
        status: 'completed',
        items: [
          { type: 'userMessage', content: [{ type: 'text', text: 'Fix the vault' }] },
          { type: 'agentMessage', text: 'Done.' },
        ],
      },
    ],
  },
  olderCursor: null,
};

function bridgeWith(overrides: Record<string, unknown> = {}) {
  let emit: (event: AppEvent) => void = () => undefined;
  const bridge = provideBridge({
    available: true,
    onEvent: vi.fn((handler: typeof emit) => {
      emit = handler;
      return Promise.resolve(() => undefined);
    }),
    getSetting: vi.fn((_key: string, fallback: unknown) => Promise.resolve(fallback)),
    setSetting: vi.fn().mockResolvedValue(undefined),
    scanWorkspaces: vi.fn().mockResolvedValue([{ name: 'leaf', path: '/home/nils/leaf' }]),
    githubPullRequests: vi.fn().mockResolvedValue([]),
    codexModels: vi.fn().mockResolvedValue([
      {
        id: 'gpt-6-astra',
        name: 'GPT-6-Astra',
        description: '',
        efforts: ['low', 'max'],
        defaultEffort: 'low',
        isDefault: true,
      },
    ]),
    codexListThreads: vi.fn().mockResolvedValue({ threads: [thread.thread], nextCursor: null }),
    codexReadThread: vi.fn().mockResolvedValue(thread),
    claudeListSessions: vi.fn().mockResolvedValue([session()]),
    claudeReadSession: vi.fn().mockResolvedValue(session()),
    claudeAsk: vi.fn().mockResolvedValue('job-1'),
    codexAsk: vi.fn().mockResolvedValue('job-2'),
    runNotificationAction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
  return { bridge, emit: (event: AppEvent) => act(() => emit(event)) };
}

it('lists both agents newest first and filters to one', async () => {
  bridgeWith();
  render(<Agents request={null} onRequestHandled={() => undefined} />);
  const list = within(screen.getByRole('navigation', { name: 'Conversations' }));
  await list.findByText('Fix the vault');
  const titles = list.getAllByRole('button').map((b) => b.textContent);
  expect(titles[0]).toContain('Why is the probe failing?');
  expect(titles[1]).toContain('gpt-6-astra');

  const show = within(screen.getByRole('group', { name: 'Show' }));
  fireEvent.click(show.getByRole('button', { name: 'Codex' }));
  expect(list.queryByText('Why is the probe failing?')).toBeNull();
});

it('shows reasoning and folded steps, and continues on the model and effort you pick', async () => {
  const { bridge, emit } = bridgeWith();
  const handled = vi.fn();
  render(<Agents request={{ agent: 'claude', id: 'a1' }} onRequestHandled={handled} />);
  const conversation = within(screen.getByRole('article', { name: 'Conversation' }));

  expect(await conversation.findByText('Check the token first.')).toBeTruthy();
  expect(conversation.getByText('2 steps · Run `npm test`')).toBeTruthy();
  expect(conversation.getByText(/Claude · claude-opus-5-5/)).toBeTruthy();
  await waitFor(() => expect(handled).toHaveBeenCalledOnce());

  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
    target: { value: 'sonnet' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Reasoning effort' }), {
    target: { value: 'xhigh' },
  });
  expect(bridge.setSetting).toHaveBeenLastCalledWith(
    'agents.choice',
    expect.objectContaining({ claude: { model: 'sonnet', effort: 'xhigh' } }),
  );

  fireEvent.change(screen.getByRole('textbox', { name: 'Message Claude' }), {
    target: { value: 'And how do I fix it?' },
  });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message Claude' }), { key: 'Enter' });
  await waitFor(() =>
    expect(bridge.claudeAsk).toHaveBeenCalledWith('And how do I fix it?', '/home/nils/leaf', 'a1', {
      model: 'sonnet',
      effort: 'xhigh',
    }),
  );
  // What you sent shows at once, and Claude's question is answered right here.
  expect(conversation.getByText('And how do I fix it?')).toBeTruthy();
  const allow = { id: 'allow', label: 'Allow', request: 'r1' } as const;
  emit({
    type: 'notification',
    notificationId: 'job-1',
    jobId: 'job-1',
    hueSource: 'claude',
    title: 'Claude · And how do I fix it?',
    detail: 'Run `npm test`',
    status: 'waiting',
    actions: [allow, { id: 'deny', label: 'Deny', request: 'r1' }],
  });
  fireEvent.click(conversation.getByRole('button', { name: 'Allow' }));
  expect(bridge.runNotificationAction).toHaveBeenCalledWith(allow, 'job-1');

  vi.mocked(bridge.claudeReadSession).mockResolvedValue(
    session(['The **token** expired.'], { usd: 0.43, turns: 1 }),
  );
  emit({ type: 'notificationDone', jobId: 'other', ok: true });
  expect(bridge.claudeReadSession).toHaveBeenCalledTimes(1);
  emit({ type: 'notificationDone', jobId: 'job-1', ok: true });
  expect((await conversation.findByText('token')).tagName).toBe('STRONG');
  expect(screen.getByText('That turn cost $0.43.')).toBeTruthy();
});

it('starts a new Codex chat in the picked workspace and opens it when it answers', async () => {
  const { bridge, emit } = bridgeWith();
  render(<Agents request={null} onRequestHandled={() => undefined} />);
  const head = within(screen.getByRole('group', { name: 'Agent' }));
  fireEvent.click(head.getByRole('button', { name: 'Codex' }));
  await screen.findByRole('option', { name: 'Default · GPT-6-Astra' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Codex' }), {
    target: { value: 'Fix the vault' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() =>
    expect(bridge.codexAsk).toHaveBeenCalledWith('Fix the vault', '/home/nils/leaf', null, {
      model: null,
      effort: null,
    }),
  );
  emit({
    type: 'notification',
    notificationId: 'job-2',
    jobId: 'job-2',
    hueSource: 'codex',
    title: 'Codex · Fix the vault',
    status: 'done',
    actions: [{ id: 'open', label: 'Open thread', url: 'relay://codex/t1' }],
  });
  emit({ type: 'notificationDone', jobId: 'job-2', ok: true });
  await waitFor(() => expect(bridge.codexReadThread).toHaveBeenCalledWith('t1'));
  expect(await screen.findByText(/Codex · gpt-6-astra · High/)).toBeTruthy();
});

it('reads Codex items as chat entries, reasoning included', () => {
  expect(codexEntries({ type: 'reasoning', summary: ['Look at the lock.'], content: [] })).toEqual([
    { kind: 'thinking', text: 'Look at the lock.' },
  ]);
  expect(codexEntries({ type: 'reasoning', summary: [], content: [] })).toEqual([]);
  expect(
    codexEntries({ type: 'commandExecution', command: 'cargo test', aggregatedOutput: 'ok' }),
  ).toEqual([{ kind: 'tool', text: 'Run `cargo test`', detail: 'ok' }]);
  expect(
    codexEntries({
      type: 'userMessage',
      content: [{ type: 'text', text: '<environment_context>cwd</environment_context>' }],
    }),
  ).toEqual([]);
  expect(
    steps([
      { kind: 'tool', text: 'a' },
      { kind: 'tool', text: 'b' },
    ]),
  ).toEqual([
    {
      kind: 'steps',
      entries: [
        { kind: 'tool', text: 'a' },
        { kind: 'tool', text: 'b' },
      ],
    },
  ]);
  expect(chatFromLink('relay://codex/t1')).toEqual({ agent: 'codex', id: 't1' });
  expect(chatFromLink('https://example.com')).toBeNull();
});

it('says "under $0.01" rather than rounding a cost down to nothing', () => {
  expect(formatUsd(0.004)).toBe('under $0.01');
  expect(formatUsd(0.4335)).toBe('$0.43');
});

it('removes structured prompt wrappers and HTML tags from thread previews', () => {
  expect(
    codexThreadPreview(
      '<heartbeat><automation_id>watch-checks</automation_id></heartbeat> Please <strong>review</strong> this PR',
    ),
  ).toBe('Please review this PR');
  expect(codexThreadTitle({ name: '<b>Named thread</b>', preview: '' })).toBe('Named thread');
});

it('opens relay:// agent links in the Agents tab instead of the browser', async () => {
  const bridge = provideBridge({ runCoreCommand: vi.fn().mockResolvedValue(undefined) });
  await bridge.openUrl('relay://claude/24f45911-f12e-4bfe-a250-7a2b7f9389bd');
  await bridge.openUrl('relay://codex/019a-thread');
  expect(bridge.runCoreCommand.mock.calls).toEqual([
    [{ id: 'open_claude', args: { sessionId: '24f45911-f12e-4bfe-a250-7a2b7f9389bd' } }],
    [{ id: 'open_agent_thread', args: { threadId: '019a-thread' } }],
  ]);
});

it('answers a permission request from its Allow or Deny action', async () => {
  const bridge = provideBridge({ approvalAnswer: vi.fn().mockResolvedValue(undefined) });
  await bridge.runNotificationAction({ id: 'allow', label: 'Allow', request: 'approval-1' }, 'j');
  await bridge.runNotificationAction({ id: 'deny', label: 'Deny', request: 'approval-2' }, 'j');
  expect(bridge.approvalAnswer.mock.calls).toEqual([
    ['approval-1', true],
    ['approval-2', false],
  ]);
});
