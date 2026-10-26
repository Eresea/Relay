import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { TauriBridge, type ClaudeSession } from '@/core/tauri';
import { provideBridge } from '@/test/bridge';

import Claude from './claude';

const session = (id: string, title: string, replies: string[] = []): ClaudeSession => ({
  id,
  title,
  cwd: '/home/nils/leaf',
  updatedAt: Math.floor(Date.now() / 1000),
  messages: [
    { role: 'user', text: title, timestamp: null },
    ...replies.map((text) => ({ role: 'assistant' as const, text, timestamp: null })),
  ],
});

it('lists sessions, opens the requested one and resumes it in its own folder', async () => {
  let answered = false;
  const bridge = provideBridge({
    claudeListSessions: vi
      .fn()
      .mockResolvedValue([
        session('a1', 'Why is the probe failing?'),
        session('b2', 'Explain the vault format'),
      ]),
    claudeReadSession: vi.fn((id: string) =>
      Promise.resolve(
        session(id, 'Why is the probe failing?', answered ? ['The **token** expired.'] : []),
      ),
    ),
    claudeSend: vi.fn(() => {
      answered = true;
      return Promise.resolve({ sessionId: 'a1', response: 'The token expired.', costUsd: 0.01 });
    }),
  });
  const handled = vi.fn();
  render(<Claude openSessionId="a1" onSessionHandled={handled} />);

  const sessions = within(screen.getByRole('navigation', { name: 'Sessions' }));
  expect(await sessions.findByText('Explain the vault format')).toBeTruthy();
  await waitFor(() => expect(handled).toHaveBeenCalledOnce());
  expect(bridge.claudeReadSession).toHaveBeenCalledWith('a1');

  fireEvent.change(screen.getByRole('textbox', { name: 'Reply to Claude' }), {
    target: { value: 'And how do I fix it?' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  await waitFor(() =>
    expect(bridge.claudeSend).toHaveBeenCalledWith('And how do I fix it?', '/home/nils/leaf', 'a1'),
  );
  // The answer is rendered as Markdown once the transcript is re-read.
  const conversation = within(screen.getByRole('article', { name: 'Conversation' }));
  expect((await conversation.findByText('token')).tagName).toBe('STRONG');
});

it('opens relay://claude links in the Claude tab instead of the browser', async () => {
  const bridge = provideBridge({ runCoreCommand: vi.fn().mockResolvedValue(undefined) });
  await bridge.openUrl('relay://claude/24f45911-f12e-4bfe-a250-7a2b7f9389bd');
  expect(bridge.runCoreCommand).toHaveBeenCalledWith({
    id: 'open_claude',
    args: { sessionId: '24f45911-f12e-4bfe-a250-7a2b7f9389bd' },
  });
  expect(bridge).toBeInstanceOf(TauriBridge);
});
