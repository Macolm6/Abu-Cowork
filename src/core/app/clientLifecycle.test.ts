import { describe, expect, it } from 'vitest';
import { registerClientInitializer, startClientLifecycle } from './clientLifecycle';

describe('client lifecycle', () => {
  it('starts registered clients and disposes them in reverse order', () => {
    const calls: string[] = [];
    const unregisterFirst = registerClientInitializer(() => {
      calls.push('first');
      return () => { calls.push('first cleanup'); };
    });
    const unregisterSecond = registerClientInitializer(() => {
      calls.push('second');
      return () => { calls.push('second cleanup'); };
    });
    const stop = startClientLifecycle();
    expect(calls).toEqual(['first', 'second']);
    stop();
    expect(calls).toEqual(['first', 'second', 'second cleanup', 'first cleanup']);
    unregisterFirst();
    unregisterSecond();
    startClientLifecycle()();
    expect(calls).toHaveLength(4);
  });
});
