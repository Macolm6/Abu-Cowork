import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import {
  FIXTURE_TEXT,
  expectedForText,
  loadLoadedMessageSanitizerFixtures,
} from '@/test/loadedMessageSanitizerFixtures';
import {
  ACTIVE_RUN_STATES,
  collectAnsweredLoopIds,
  recoverInterruptedUserRun,
  sanitizeLoadedLedgerMessages,
  sanitizeRunErrorKind,
  sanitizeRunInterruptCause,
} from './loadedMessageSanitizer';

const { cases } = loadLoadedMessageSanitizerFixtures();

/** What a JSON wire or a ledger line would keep of a value: no `undefined` members. */
function asJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('sanitizeLoadedLedgerMessages', () => {
  it('the fixture file covers every rule', () => {
    expect(cases.length).toBeGreaterThanOrEqual(9);
    expect(cases.some((c) => c.currentRunMessageId !== undefined)).toBe(true);
  });

  for (const testCase of cases) {
    it(`fixture: ${testCase.name}`, () => {
      const out = sanitizeLoadedLedgerMessages(testCase.input as Message[], {
        text: FIXTURE_TEXT,
        currentRunMessageId: testCase.currentRunMessageId,
      });
      expect(asJson(out)).toEqual(expectedForText(testCase.expected, FIXTURE_TEXT));
    });
  }

  it('leaves its input untouched', () => {
    for (const testCase of cases) {
      const before = JSON.stringify(testCase.input);
      sanitizeLoadedLedgerMessages(testCase.input as Message[], { text: FIXTURE_TEXT });
      expect(JSON.stringify(testCase.input)).toBe(before);
    }
  });

  it('without currentRunMessageId the newest pending row is recovered like any other', () => {
    const current = cases.find((c) => c.currentRunMessageId !== undefined)!;
    const out = sanitizeLoadedLedgerMessages(current.input as Message[], { text: FIXTURE_TEXT });
    expect(out.map((m) => m.runState)).toEqual(['interrupted', 'interrupted']);
    expect(out.map((m) => m.runInterruptCause)).toEqual(['app_exit', 'app_exit']);
  });

  it('a row recovered from a stale active state carries no failure text', () => {
    const out = sanitizeLoadedLedgerMessages([
      { id: 'u1', role: 'user', content: 'x', timestamp: 1, runState: 'running', runError: 'left over' },
    ] as Message[], { text: FIXTURE_TEXT });
    expect(out[0]).toMatchObject({ runState: 'interrupted', runInterruptCause: 'app_exit' });
    expect('runError' in out[0]).toBe(false);
  });
});

describe('recoverInterruptedUserRun', () => {
  const pending = { id: 'm1', role: 'user', content: 'x', timestamp: 1, runState: 'pending' } as Message;

  it('names every active state', () => {
    expect([...ACTIVE_RUN_STATES].sort()).toEqual(['accepted', 'pending', 'recovering', 'running']);
  });

  it('returns the current run row as the same object', () => {
    expect(recoverInterruptedUserRun(pending, { currentRunMessageId: 'm1' })).toBe(pending);
  });

  it('marks a stale active row as a run the application closed on', () => {
    expect(recoverInterruptedUserRun(pending, {})).toMatchObject({
      runState: 'interrupted',
      runInterruptCause: 'app_exit',
    });
  });

  it('completes a stale active row whose loop answered', () => {
    const out = recoverInterruptedUserRun({ ...pending, loopId: 'L1' }, { answeredLoopIds: new Set(['L1']) });
    expect(out.runState).toBe('completed');
    expect('runInterruptCause' in out).toBe(false);
  });

  it('leaves a run the user stopped as it is', () => {
    const stopped = { ...pending, runState: 'interrupted' } as Message;
    expect(recoverInterruptedUserRun(stopped, {})).toBe(stopped);
  });
});

describe('helpers', () => {
  it('sanitizeRunErrorKind keeps the closed set only', () => {
    expect(sanitizeRunErrorKind('dispatch_failed')).toBe('dispatch_failed');
    expect(sanitizeRunErrorKind('payload_too_large')).toBe('payload_too_large');
    expect(sanitizeRunErrorKind('sidecar_unavailable')).toBe('sidecar_unavailable');
    expect(sanitizeRunErrorKind('history_unavailable')).toBeUndefined();
    expect(sanitizeRunErrorKind(7)).toBeUndefined();
  });

  it('sanitizeRunInterruptCause keeps the closed set only', () => {
    expect(sanitizeRunInterruptCause('app_exit')).toBe('app_exit');
    expect(sanitizeRunInterruptCause('user')).toBeUndefined();
    expect(sanitizeRunInterruptCause(true)).toBeUndefined();
  });

  it('collectAnsweredLoopIds takes usage on a substantive assistant row as proof', () => {
    const rows = [
      { id: 'a', role: 'assistant', content: '半句', timestamp: 1, loopId: 'L-cut' },
      { id: 'b', role: 'assistant', content: '整句', timestamp: 2, loopId: 'L-done', usage: { inputTokens: 1, outputTokens: 1 } },
      { id: 'c', role: 'assistant', content: '', timestamp: 3, loopId: 'L-ghost', usage: { inputTokens: 1, outputTokens: 0 } },
    ] as Message[];
    expect([...collectAnsweredLoopIds(rows)]).toEqual(['L-done']);
  });

  it('collectAnsweredLoopIds takes a finished last answer without usage as proof', () => {
    const tool = [{ id: 't', name: 'read_file', input: {}, result: 'ok' }];
    const rows = [
      { id: 'a', role: 'assistant', content: '答', timestamp: 1, loopId: 'L-final', isStreaming: false, streamEnded: true },
      // What a periodic stream snapshot leaves on disk: the flag is cleared, the mark is absent.
      { id: 'b', role: 'assistant', content: '半句', timestamp: 2, loopId: 'L-snapshot', isStreaming: false },
      { id: 'c', role: 'assistant', content: '没有标记', timestamp: 3, loopId: 'L-unmarked' },
      { id: 'd', role: 'assistant', content: '先读', timestamp: 4, loopId: 'L-tool-step', isStreaming: false, streamEnded: true, toolCalls: tool },
      { id: 'e', role: 'assistant', content: '答', timestamp: 5, loopId: 'L-then-tool', isStreaming: false, streamEnded: true },
      { id: 'f', role: 'assistant', content: '', timestamp: 6, loopId: 'L-then-tool', isStreaming: false, streamEnded: true, toolCalls: tool },
      { id: 'g', role: 'assistant', content: [{ type: 'text', text: '  ' }], timestamp: 7, loopId: 'L-blank', isStreaming: false, streamEnded: true },
    ] as Message[];
    expect([...collectAnsweredLoopIds(rows)]).toEqual(['L-final']);
  });
});
