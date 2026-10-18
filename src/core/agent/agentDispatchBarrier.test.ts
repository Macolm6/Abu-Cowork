import { describe, expect, it } from 'vitest';
import { acquireAgentDispatchBarrier, runAgentLoopDispatched } from './agentLoopRunner';

describe('agent dispatch barrier', () => {
  it('keeps admission closed until every owner releases its barrier', async () => {
    const first = acquireAgentDispatchBarrier();
    const second = acquireAgentDispatchBarrier();
    await first.wait();
    await expect(runAgentLoopDispatched('conversation', 'request')).rejects.toThrow('application exit');
    first.release();
    await expect(runAgentLoopDispatched('conversation', 'request')).rejects.toThrow('application exit');
    second.release();
  });
});
