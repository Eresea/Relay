import { describe, expect, it } from 'vitest';

import { parseInvocation } from './invocation';

describe('parseInvocation', () => {
  it('keeps normal input in command mode', () => {
    expect(parseInvocation('open settings')).toEqual({
      kind: 'command',
      query: 'open settings',
    });
  });

  it('recognises an incomplete agent mention', () => {
    expect(parseInvocation('@gem')).toEqual({
      kind: 'agent',
      agentId: 'gem',
      agentQuery: 'gem',
      prompt: null,
    });
  });

  it('splits and normalises an agent prompt', () => {
    expect(parseInvocation('  @Gemini What is the capital of France?')).toEqual({
      kind: 'agent',
      agentId: 'gemini',
      agentQuery: 'gemini',
      prompt: 'What is the capital of France?',
    });
  });

  it('treats whitespace after the mention without a prompt as incomplete', () => {
    expect(parseInvocation('@gemini   ')).toEqual({
      kind: 'agent',
      agentId: 'gemini',
      agentQuery: 'gemini',
      prompt: null,
    });
  });

  it('does not steal invalid mentions from command search', () => {
    expect(parseInvocation('@gemini?')).toEqual({
      kind: 'command',
      query: '@gemini?',
    });
  });
});
