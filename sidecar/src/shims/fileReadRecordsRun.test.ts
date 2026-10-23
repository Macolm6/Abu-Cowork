import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunContext, type AgentRunContext } from '../agentRunContext';
import * as rpcClient from '../rpcClient';
import { recordFileVersion, recordedFileVersion } from './fileReadRecordsRun';

function makeCtx(overrides?: Partial<AgentRunContext>): AgentRunContext {
  return {
    runId: 'run-1',
    conversationId: 'conv-1',
    chatDelta: {} as AgentRunContext['chatDelta'],
    conversationReader: {} as AgentRunContext['conversationReader'],
    executionPort: {} as AgentRunContext['executionPort'],
    abortRegistry: {} as AgentRunContext['abortRegistry'],
    scratchpadPort: {} as AgentRunContext['scratchpadPort'],
    capsPort: {} as AgentRunContext['capsPort'],
    workspaceReader: {} as AgentRunContext['workspaceReader'],
    toolInvoker: {} as AgentRunContext['toolInvoker'],
    resolvedCreds: { apiKey: '', baseUrl: undefined, forceOpenAiCompatible: false },
    locale: 'en-US',
    pushFrame: () => {},
    ...overrides,
  };
}

describe('fileReadRecordsRun shim', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('records in the shell under the ambient run, naming a nested subagent run from the call', async () => {
    const spy = vi.spyOn(rpcClient, 'sendRequest').mockResolvedValue(null);
    await agentRunContext.run(makeCtx(), () =>
      recordFileVersion('/w/a.txt', 'abc', { conversationId: 'conv-1', agentRunId: 'sar-n' }),
    );
    expect(spy).toHaveBeenCalledExactlyOnceWith('fileReads.record', {
      runId: 'run-1', agentRunId: 'sar-n', path: '/w/a.txt', version: 'abc',
    });
  });

  it('records an absent file as null', async () => {
    const spy = vi.spyOn(rpcClient, 'sendRequest').mockResolvedValue(null);
    await agentRunContext.run(makeCtx(), () => recordFileVersion('/w/a.txt', null, { conversationId: 'conv-1' }));
    expect(spy).toHaveBeenCalledWith('fileReads.record', {
      runId: 'run-1', agentRunId: undefined, path: '/w/a.txt', version: null,
    });
  });

  it('answers the shell\'s recorded version, null included, and undefined for a path never read', async () => {
    const spy = vi.spyOn(rpcClient, 'sendRequest')
      .mockResolvedValueOnce({ recorded: true, version: 'abc' })
      .mockResolvedValueOnce({ recorded: true, version: null })
      .mockResolvedValueOnce({ recorded: false });
    const results = await agentRunContext.run(makeCtx(), async () => [
      await recordedFileVersion('/w/a.txt', { conversationId: 'conv-1' }),
      await recordedFileVersion('/w/b.txt', { conversationId: 'conv-1' }),
      await recordedFileVersion('/w/c.txt', { conversationId: 'conv-1' }),
    ]);
    expect(results).toEqual(['abc', null, undefined]);
    expect(spy).toHaveBeenNthCalledWith(1, 'fileReads.get', { runId: 'run-1', agentRunId: undefined, path: '/w/a.txt' });
  });

  it('refuses to answer from a malformed reply, so write_file writes nothing on it', async () => {
    vi.spyOn(rpcClient, 'sendRequest').mockResolvedValue({ recorded: true, version: 42 });
    await expect(agentRunContext.run(makeCtx(), () =>
      recordedFileVersion('/w/a.txt', { conversationId: 'conv-1' }),
    )).rejects.toThrow('Invalid fileReads.get reply');
  });

  it('lets a failed request fail the call', async () => {
    vi.spyOn(rpcClient, 'sendRequest').mockRejectedValue(new Error('Sidecar process closed'));
    await expect(agentRunContext.run(makeCtx(), () =>
      recordFileVersion('/w/a.txt', 'abc', { conversationId: 'conv-1' }),
    )).rejects.toThrow('Sidecar process closed');
  });
});
