import { describe, it, expect } from 'vitest';
import { computeRewindImpact, redoScope } from './rewindImpact';
import type { Message } from '@/types';

function msg(id: string, role: Message['role'], loopId?: string): Message {
  return { id, role, content: '', timestamp: 0, ...(loopId ? { loopId } : {}) };
}

describe('computeRewindImpact', () => {
  it('reports no later turns when the redone loop is the conversation tail', () => {
    const messages = [
      msg('u1', 'user', 'loop-1'),
      msg('a1', 'assistant', 'loop-1'),
    ];
    const impact = computeRewindImpact(messages, 'loop-1', 'u1');
    expect(impact).toEqual({ hasLaterTurns: false, laterTurnsCount: 0 });
  });

  it('detects later turns when redoing a middle loop, counting distinct trailing loopIds', () => {
    const messages = [
      msg('u1', 'user', 'loop-1'),
      msg('a1', 'assistant', 'loop-1'),
      msg('u2', 'user', 'loop-2'),
      msg('a2', 'assistant', 'loop-2'),
      msg('u3', 'user', 'loop-3'),
      msg('a3', 'assistant', 'loop-3'),
    ];
    const impact = computeRewindImpact(messages, 'loop-1', 'u1');
    expect(impact.hasLaterTurns).toBe(true);
    expect(impact.laterTurnsCount).toBe(2); // loop-2, loop-3
  });

  it('counts multi-message loops (e.g. multi-turn tool use) as a single later turn', () => {
    const messages = [
      msg('u1', 'user', 'loop-1'),
      msg('a1', 'assistant', 'loop-1'),
      msg('u2', 'user', 'loop-2'),
      msg('a2a', 'assistant', 'loop-2'),
      msg('a2b', 'assistant', 'loop-2'),
      msg('a2c', 'assistant', 'loop-2'),
    ];
    const impact = computeRewindImpact(messages, 'loop-1', 'u1');
    expect(impact).toEqual({ hasLaterTurns: true, laterTurnsCount: 1 });
  });

  it('falls back to fallbackMessageId when loopId is absent (legacy transcripts)', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant'),
      msg('u2', 'user'),
      msg('a2', 'assistant'),
    ];
    const impact = computeRewindImpact(messages, undefined, 'u1');
    expect(impact.hasLaterTurns).toBe(true);
    // No loopId anywhere — each trailing message counts as its own anonymous turn.
    expect(impact.laterTurnsCount).toBe(3);
  });

  it('falls back to fallbackMessageId when the loop is not found in messages', () => {
    const messages = [
      msg('u1', 'user', 'loop-1'),
      msg('a1', 'assistant', 'loop-1'),
    ];
    // loopId does not match anything in messages — falls back to the id.
    const impact = computeRewindImpact(messages, 'missing-loop', 'a1');
    expect(impact).toEqual({ hasLaterTurns: false, laterTurnsCount: 0 });
  });

  it('returns no later turns when the anchor id is not found at all', () => {
    const messages = [msg('u1', 'user', 'loop-1')];
    const impact = computeRewindImpact(messages, undefined, 'does-not-exist');
    expect(impact).toEqual({ hasLaterTurns: false, laterTurnsCount: 0 });
  });
});

describe('redoScope', () => {
  it('lists the loops from the cut in conversation order', () => {
    const messages = [
      msg('u1', 'user', 'l1'),
      msg('a1', 'assistant', 'l1'),
      msg('u2', 'user', 'l2'),
      msg('a2', 'assistant', 'l2'),
      msg('u3', 'user', 'l3'),
      msg('a3', 'assistant', 'l3'),
    ];
    expect(redoScope(messages, 'u2')).toEqual({ loopIds: ['l2', 'l3'], laterTurnsCount: 1 });
  });
  it('gives the last turn alone with no later turns', () => {
    expect(redoScope([msg('u1', 'user', 'l1'), msg('a1', 'assistant', 'l1')], 'u1')).toEqual({ loopIds: ['l1'], laterTurnsCount: 0 });
  });
  it('leaves out a loop that also has a message before the cut', () => {
    const messages = [
      msg('u1', 'user', 'l1'),
      msg('a1', 'assistant', 'l1'),
      msg('u2', 'user', 'l1'),
      msg('a2', 'assistant', 'l1'),
      msg('u3', 'user', 'l2'),
    ];
    expect(redoScope(messages, 'u2')).toEqual({ loopIds: ['l2'], laterTurnsCount: 1 });
  });
  it('skips messages without a loop id', () => {
    expect(redoScope([msg('u1', 'user'), msg('a1', 'assistant')], 'u1')).toEqual({ loopIds: [], laterTurnsCount: 1 });
  });
  it('lists the later loops after a cut message without a loop id', () => {
    const messages = [msg('u1', 'user'), msg('u2', 'user', 'l2'), msg('a2', 'assistant', 'l2')];
    expect(redoScope(messages, 'u1')).toEqual({ loopIds: ['l2'], laterTurnsCount: 1 });
  });
  it('throws for a cut message that is not there', () => {
    expect(() => redoScope([msg('u1', 'user', 'l1')], 'gone')).toThrow('Redo cut message is not in the conversation');
  });
});
