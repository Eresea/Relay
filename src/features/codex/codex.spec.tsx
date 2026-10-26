import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import {
  codexThreadPreview,
  codexThreadTitle,
  type CodexThreadDetails,
  type CodexThreadSummary,
} from '@/core/tauri';
import { provideBridge } from '@/test/bridge';

import Codex from './codex';

const summary: CodexThreadSummary = {
  id: 'older-thread',
  name: 'Named thread',
  preview: 'First prompt',
  cwd: 'F:/Code/Apps/Relay',
  createdAt: 1,
  updatedAt: 2,
  recencyAt: 3,
  model: 'Codex',
};
const details: CodexThreadDetails = {
  thread: {
    ...summary,
    turns: [
      {
        id: 'recent',
        status: 'completed',
        items: [
          { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Earlier request' }] },
          { id: 'assistant', type: 'agentMessage', text: '**Reply**' },
        ],
      },
    ],
  },
  olderCursor: 'earlier',
};

function bridgeWith(overrides: Record<string, unknown> = {}) {
  return provideBridge({
    available: true,
    scanWorkspaces: vi.fn().mockResolvedValue([]),
    codexListThreads: vi.fn().mockResolvedValue({ threads: [], nextCursor: null }),
    githubPullRequests: vi.fn().mockResolvedValue([]),
    codexReadThread: vi.fn().mockResolvedValue(details),
    codexOlderTurns: vi.fn().mockResolvedValue({
      turns: [
        {
          id: 'earlier',
          status: 'completed',
          items: [
            { type: 'userMessage', content: [{ type: 'text', text: 'Oldest prompt' }] },
            { type: 'agentMessage', text: 'Oldest reply' },
          ],
        },
      ],
      nextCursor: null,
    }),
    openUrl: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

const buttonNamed = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text || button.textContent?.includes(text),
  )!;

it('removes structured prompt wrappers and HTML tags from thread previews', () => {
  expect(
    codexThreadPreview(
      '<heartbeat><automation_id>watch-checks</automation_id></heartbeat> Please <strong>review</strong> this PR',
    ),
  ).toBe('Please review this PR');
  expect(codexThreadTitle({ name: '<b>Named thread</b>', preview: '' })).toBe('Named thread');
});

it('groups threads by workspace, sorts groups by recency, and reveals five more per group', async () => {
  const relayThreads = Array.from({ length: 7 }, (_, index) => ({
    ...summary,
    id: `relay-${index}`,
    name: `Relay ${index + 1}`,
    recencyAt: 30 - index,
    gitInfo: { originUrl: 'https://github.com/Eresea/Relay.git', branch: 'main' },
  }));
  bridgeWith({
    codexListThreads: vi.fn().mockResolvedValue({
      threads: [
        ...relayThreads,
        {
          ...summary,
          id: 'leaf',
          name: 'Leaf thread',
          cwd: 'F:/Code/Apps/Leaf',
          recencyAt: 20,
          gitInfo: { originUrl: 'https://github.com/Eresea/Leaf.git', branch: 'main' },
        },
      ],
      nextCursor: null,
    }),
  });
  const { container } = render(<Codex />);

  await waitFor(() => expect(container.querySelectorAll('.thread-row')).toHaveLength(6));
  expect(
    [...container.querySelectorAll('.thread-group-heading > span:first-child')].map((node) =>
      node.textContent?.trim(),
    ),
  ).toEqual(['Eresea/Relay', 'Eresea/Leaf']);
  expect(
    [...container.querySelectorAll('.thread-row-title')].map((node) => node.textContent?.trim()),
  ).toEqual(['Relay 1', 'Relay 2', 'Relay 3', 'Relay 4', 'Relay 5', 'Leaf thread']);

  fireEvent.click(container.querySelector('.thread-group-more [data-slot="button"]')!);
  expect(container.querySelectorAll('.thread-row')).toHaveLength(8);
  expect(container.querySelectorAll('.thread-group-more')).toHaveLength(0);
});

it('opens a requested ID outside the first list page and prepends earlier history in order', async () => {
  const bridge = bridgeWith();
  const { container } = render(<Codex openThreadId={summary.id} />);

  await waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Named thread'));
  expect(bridge.codexReadThread).toHaveBeenCalledWith(summary.id);
  expect(container.querySelector('.markdown strong')?.textContent).toBe('Reply');

  fireEvent.click(buttonNamed('Load earlier'));
  await waitFor(() =>
    expect(
      [...container.querySelectorAll('.message .markdown')].map((node) => node.textContent?.trim()),
    ).toEqual(['Oldest prompt', 'Oldest reply', 'Earlier request', 'Reply']),
  );
  expect(bridge.codexOlderTurns).toHaveBeenCalledWith(summary.id, 'earlier');

  fireEvent.click(buttonNamed('Open in Codex'));
  expect(bridge.openUrl).toHaveBeenCalledWith('codex://threads/older-thread');

  fireEvent.click(buttonNamed('Continue'));
  expect(container.querySelector('input')?.value).toBe(summary.id);
});

it('lists names, pages without duplicate rows, and retains the list on refresh failure', async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce({ threads: [summary], nextCursor: 'more' })
    .mockResolvedValueOnce({
      threads: [summary, { ...summary, id: 'second', name: 'Second thread' }],
      nextCursor: null,
    })
    .mockRejectedValueOnce('Codex unavailable');
  bridgeWith({ codexListThreads: list });
  const { container } = render(<Codex />);

  await waitFor(() =>
    expect(container.querySelector('.thread-row-title')?.textContent).toBe('Named thread'),
  );

  fireEvent.click(container.querySelector('.load-more [data-slot="button"]')!);
  await waitFor(() => expect(container.querySelectorAll('.thread-row')).toHaveLength(2));
  expect(list).toHaveBeenLastCalledWith('more');

  fireEvent.click(buttonNamed('Refresh'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Codex unavailable'));
  expect(container.querySelectorAll('.thread-row')).toHaveLength(2);
});

it('does not replace a newly requested thread with an older read response', async () => {
  let finishFirst!: (value: CodexThreadDetails) => void;
  const read = vi
    .fn()
    .mockReturnValueOnce(
      new Promise<CodexThreadDetails>((resolve) => {
        finishFirst = resolve;
      }),
    )
    .mockResolvedValue(details);
  bridgeWith({ codexReadThread: read });
  const { container, rerender } = render(<Codex openThreadId="first" />);
  rerender(<Codex openThreadId="second" />);

  await act(async () => {
    await Promise.resolve();
    finishFirst({
      thread: { ...details.thread, id: 'first', name: 'Stale response' },
      olderCursor: null,
    });
  });

  await waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Named thread'));
});
