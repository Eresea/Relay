import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { provideBridge } from '@/test/bridge';

import { Link, formatPairingInput } from './link';

const pc = { id: 'phone', name: 'Android phone', pairedAt: 1 };
const desktop = { id: 'pc', name: 'DESKTOP-1', pairedAt: 1 };

it('shows the code while the PC waits for the phone, then the paired phone', async () => {
  const status = vi.fn().mockResolvedValue({ role: 'pc', devices: [pc], pairing: null });
  const bridge = provideBridge({
    linkStatus: status,
    linkPairStart: vi.fn().mockResolvedValue({
      role: 'pc',
      devices: [],
      pairing: { code: 'ABCDE12345', expiresAt: 9 },
    }),
  });
  render(<Link />);

  expect(await screen.findByText('Android phone')).toBeTruthy();
  // A PC only ever answers: it has nothing to ask a phone for.
  expect(screen.queryByRole('button', { name: 'List processes' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' }));
  expect(await screen.findByText('ABCDE-12345')).toBeTruthy();
  expect(bridge.linkPairStart).toHaveBeenCalledOnce();
});

it('lets the phone type a code and ask a paired PC for its processes', async () => {
  const bridge = provideBridge({
    linkStatus: vi.fn().mockResolvedValue({ role: 'phone', devices: [desktop], pairing: null }),
    linkPair: vi.fn().mockResolvedValue({ role: 'phone', devices: [desktop], pairing: null }),
    linkProcesses: vi.fn().mockResolvedValue([{ pid: 42, name: 'relay.exe' }]),
  });
  render(<Link />);

  fireEvent.change(await screen.findByRole('textbox', { name: 'Pairing code' }), {
    target: { value: 'abcde12345' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
  await waitFor(() => expect(bridge.linkPair).toHaveBeenCalledWith('ABCDE-12345'));

  fireEvent.click(await screen.findByRole('button', { name: 'List processes' }));
  expect(await screen.findByText('relay.exe')).toBeTruthy();
  expect(bridge.linkProcesses).toHaveBeenCalledWith('pc');
});

it('formats a pairing code as it is typed', () => {
  expect(formatPairingInput('abc')).toBe('ABC');
  expect(formatPairingInput('abcde')).toBe('ABCDE');
  expect(formatPairingInput('abcdef')).toBe('ABCDE-F');
  // Backspacing over the dash's position leaves no dash behind.
  expect(formatPairingInput('ABCDE-')).toBe('ABCDE');
  expect(formatPairingInput(' ab1o2-il3k4 extra')).toBe('AB102-113K4');
  // U is not in the code's alphabet, and neither is punctuation.
  expect(formatPairingInput('u.u-A')).toBe('A');
});

it('keeps Pair off until the code is complete', async () => {
  provideBridge({
    linkStatus: vi.fn().mockResolvedValue({ role: 'phone', devices: [], pairing: null }),
  });
  render(<Link />);
  const input = await screen.findByRole('textbox', { name: 'Pairing code' });
  const pair = screen.getByRole<HTMLButtonElement>('button', { name: 'Pair' });

  fireEvent.change(input, { target: { value: 'ABCDE-1234' } });
  expect(pair.disabled).toBe(true);
  fireEvent.change(input, { target: { value: 'ABCDE-12345' } });
  expect(pair.disabled).toBe(false);
});

it('says why when the PC does not answer', async () => {
  provideBridge({
    linkStatus: vi.fn().mockResolvedValue({ role: 'phone', devices: [desktop], pairing: null }),
    linkProcesses: vi.fn().mockRejectedValue('Phone link: your PC did not answer'),
  });
  render(<Link />);

  fireEvent.click(await screen.findByRole('button', { name: 'List processes' }));
  expect((await screen.findByRole('alert')).textContent).toContain('did not answer');
});
