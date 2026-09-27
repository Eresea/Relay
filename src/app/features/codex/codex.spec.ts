import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  TauriBridge,
  codexThreadPreview,
  codexThreadTitle,
  type CodexThreadDetails,
  type CodexThreadSummary,
} from '@core/tauri';
import { Codex } from './codex';

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
const bridge = {
  available: true,
  scanWorkspaces: vi.fn(),
  codexListThreads: vi.fn(),
  githubPullRequests: vi.fn(),
  codexReadThread: vi.fn(),
  codexOlderTurns: vi.fn(),
  openUrl: vi.fn(),
};

beforeEach(() => {
  bridge.scanWorkspaces.mockResolvedValue([]);
  bridge.codexListThreads.mockResolvedValue({ threads: [], nextCursor: null });
  bridge.githubPullRequests.mockResolvedValue([]);
  bridge.codexReadThread.mockResolvedValue(details);
  bridge.codexOlderTurns.mockResolvedValue({
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
  });
  bridge.openUrl.mockResolvedValue(undefined);
  TestBed.configureTestingModule({ providers: [{ provide: TauriBridge, useValue: bridge }] });
});

afterEach(() => {
  TestBed.resetTestingModule();
  vi.resetAllMocks();
});

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
  bridge.codexListThreads.mockResolvedValueOnce({
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
  });
  const fixture = TestBed.createComponent(Codex);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(host.querySelectorAll('.thread-row')).toHaveLength(6);
  });
  expect(
    [...host.querySelectorAll('.thread-group-heading > span:first-child')].map((node) =>
      node.textContent?.trim(),
    ),
  ).toEqual(['Eresea/Relay', 'Eresea/Leaf']);
  expect(
    [...host.querySelectorAll('.thread-row-title')].map((node) => node.textContent?.trim()),
  ).toEqual(['Relay 1', 'Relay 2', 'Relay 3', 'Relay 4', 'Relay 5', 'Leaf thread']);
  host.querySelector<HTMLElement>('.thread-group-more umbra-button')!.click();
  fixture.detectChanges();
  expect(host.querySelectorAll('.thread-row')).toHaveLength(8);
  expect(host.querySelectorAll('.thread-group-more')).toHaveLength(0);
});

it('opens a requested ID outside the first list page and prepends earlier history in order', async () => {
  const fixture = TestBed.createComponent(Codex);
  fixture.componentRef.setInput('openThreadId', summary.id);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  expect(bridge.codexReadThread).toHaveBeenCalledWith(summary.id);
  expect(host.querySelector('h1')?.textContent).toBe('Named thread');
  expect(host.querySelector('.markdown strong')?.textContent).toBe('Reply');
  const earlier = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes('Load earlier'),
  )!;
  earlier.click();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(bridge.codexOlderTurns).toHaveBeenCalledWith(summary.id, 'earlier');
  expect(
    [...host.querySelectorAll('.message .markdown')].map((node) => node.textContent?.trim()),
  ).toEqual(['Oldest prompt', 'Oldest reply', 'Earlier request', 'Reply']);
  const open = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === 'Open in Codex',
  )!;
  open.click();
  expect(bridge.openUrl).toHaveBeenCalledWith('codex://threads/older-thread');
  const continueButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === 'Continue',
  )!;
  continueButton.click();
  fixture.detectChanges();
  expect(host.querySelector<HTMLInputElement>('input')?.value).toBe(summary.id);
});

it('lists names, pages without duplicate rows, and retains the list on refresh failure', async () => {
  bridge.codexListThreads.mockResolvedValueOnce({ threads: [summary], nextCursor: 'more' });
  const fixture = TestBed.createComponent(Codex);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(host.querySelector('.thread-row-title')?.textContent).toBe('Named thread');
  });
  expect(host.querySelector('.thread-row-title')?.textContent).toBe('Named thread');
  bridge.codexListThreads.mockResolvedValueOnce({
    threads: [summary, { ...summary, id: 'second', name: 'Second thread' }],
    nextCursor: null,
  });
  host.querySelector<HTMLElement>('.load-more umbra-button')!.click();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(bridge.codexListThreads).toHaveBeenLastCalledWith('more');
  expect(host.querySelectorAll('.thread-row')).toHaveLength(2);
  bridge.codexListThreads.mockRejectedValueOnce('Codex unavailable');
  [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === 'Refresh')!
    .click();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Codex unavailable');
  expect(host.querySelectorAll('.thread-row')).toHaveLength(2);
});

it('does not replace a newly requested thread with an older read response', async () => {
  let finishFirst!: (value: CodexThreadDetails) => void;
  bridge.codexReadThread.mockReturnValueOnce(
    new Promise<CodexThreadDetails>((resolve) => {
      finishFirst = resolve;
    }),
  );
  const fixture = TestBed.createComponent(Codex);
  fixture.componentRef.setInput('openThreadId', 'first');
  fixture.detectChanges();
  fixture.componentRef.setInput('openThreadId', 'second');
  fixture.detectChanges();
  await Promise.resolve();
  finishFirst({
    thread: { ...details.thread, id: 'first', name: 'Stale response' },
    olderCursor: null,
  });
  await fixture.whenStable();
  fixture.detectChanges();
  expect((fixture.nativeElement as HTMLElement).querySelector('h1')?.textContent).toBe(
    'Named thread',
  );
});
