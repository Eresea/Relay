import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import type { AppEvent } from '@/core/events';
import type { ClaudeSession } from '@/core/tauri';
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

it('lists sessions, opens the requested one and resumes it as a job', async () => {
  let emit: (event: AppEvent) => void = () => undefined;
  let answered = false;
  const bridge = provideBridge({
    onEvent: vi.fn((handler: typeof emit) => {
      emit = handler;
      return Promise.resolve(() => undefined);
    }),
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
    claudeAsk: vi.fn().mockResolvedValue('job-1'),
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
    expect(bridge.claudeAsk).toHaveBeenCalledWith('And how do I fix it?', '/home/nils/leaf', 'a1'),
  );
  expect(screen.getByText(/questions appear in the activity stack/)).toBeTruthy();

  // Another job finishing changes nothing; this turn's job re-reads the transcript.
  answered = true;
  act(() => emit({ type: 'notificationDone', jobId: 'other', ok: true }));
  expect(bridge.claudeReadSession).toHaveBeenCalledTimes(1);
  act(() => emit({ type: 'notificationDone', jobId: 'job-1', ok: true }));
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
