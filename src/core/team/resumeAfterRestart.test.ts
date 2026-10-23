import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation } from '@/types';

const runAgentLoopDispatched = vi.fn((..._args: unknown[]) => Promise.resolve({ reason: 'completed' }));
vi.mock('@/core/agent/agentLoopRunner', () => ({ runAgentLoopDispatched: (...args: unknown[]) => runAgentLoopDispatched(...args) }));

import { resumeTeamRunAfterRestart } from './resumeAfterRestart';

function conversation(over: Partial<Conversation>): Conversation {
  return {
    id: 'c1', title: 't', createdAt: 1, updatedAt: 1, status: 'idle',
    messages: [{ id: 'u1', role: 'user', content: '出一版周报', timestamp: 1 }, { id: 'a1', role: 'assistant', content: '好', timestamp: 2 }],
    ...over,
  };
}

describe('resumeTeamRunAfterRestart', () => {
  beforeEach(() => { initLanguage('zh-CN'); vi.clearAllMocks(); });

  it('continues a team conversation with the original request, as the user\'s own send', async () => {
    useChatStore.setState({ conversations: { c1: conversation({ teamId: 't1' }) } } as never);
    await expect(resumeTeamRunAfterRestart('c1')).resolves.toEqual({ reason: 'completed' });
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    const [conversationId, text, options] = runAgentLoopDispatched.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(conversationId).toBe('c1');
    expect(text).toContain('出一版周报');
    expect(text).toContain('不要重做');
    expect(options).toEqual({ initiatedBy: 'user' });
  });

  it('hands the dispatch result back unchanged', async () => {
    useChatStore.setState({ conversations: { c1: conversation({ teamId: 't1' }) } } as never);
    runAgentLoopDispatched.mockResolvedValueOnce({ reason: 'error', error: '模型未配置' } as never);
    await expect(resumeTeamRunAfterRestart('c1')).resolves.toEqual({ reason: 'error', error: '模型未配置' });
  });

  it('starts nothing for a plain, read-only, empty or missing conversation', async () => {
    useChatStore.setState({ conversations: {
      plain: conversation({ id: 'plain' }),
      ro: conversation({ id: 'ro', teamId: 't1', readOnly: true }),
      empty: conversation({ id: 'empty', teamId: 't1', messages: [] }),
      systemOnly: conversation({ id: 'systemOnly', teamId: 't1', messages: [{ id: 's1', role: 'user', content: 'x', timestamp: 1, isSystem: true }] }),
    } } as never);
    for (const id of ['plain', 'ro', 'empty', 'systemOnly', 'missing']) {
      await expect(resumeTeamRunAfterRestart(id)).resolves.toBeNull();
    }
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
  });
});
