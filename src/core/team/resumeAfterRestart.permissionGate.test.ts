import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setMigratedBrowserSettings } from '@/test/migratedBrowserSettings';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { pendingFor, useTeamConfirmationStore } from '@/stores/teamConfirmationStore';
import { deriveRunInteractionMode } from '@/core/agent/runInteractionMode';
import { clearLoopContext, requestCommandConfirmation, setLoopContext } from '@/core/agent/permissionBridge';
import { checkToolApproval, type ConfirmationInfo } from '@/core/tools/registry';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { Conversation } from '@/types';

const runAgentLoopDispatchedMock = vi.fn();

vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: (...args: unknown[]) => runAgentLoopDispatchedMock(...args),
}));

import { resumeTeamRunAfterRestart } from './resumeAfterRestart';

interface DispatchedOptions {
  commandConfirmCallback?: (info: ConfirmationInfo, loopId?: string) => Promise<boolean>;
  filePermissionCallback?: never;
  authorizationScopeId?: string;
  runPermissionCeiling?: unknown;
  initiatedBy?: 'user' | 'automation';
}

interface Observed {
  options?: DispatchedOptions;
  interactionMode?: 'foreground' | 'background';
  decision?: Awaited<ReturnType<typeof checkToolApproval>>;
  confirmationAsked: boolean;
}

const CONVERSATION_ID = 'team-conv';
const LOOP_ID = 'resume-gate-loop';
const WORKSPACE = '/Users/testuser/Abu/weekly-report';

/**
 * Drives the REAL tool gate with exactly the options the resume dispatched,
 * deriving the interaction mode and the confirmation fallback the same way
 * `agentLoopRunner` does for a real run.
 */
function dispatchThroughRealGate(toolName: string, input: Record<string, unknown>): Observed {
  const observed: Observed = { confirmationAsked: false };
  runAgentLoopDispatchedMock.mockImplementation(
    async (conversationId: string, _prompt: string, options?: DispatchedOptions) => {
      observed.options = options;
      const conversation = useChatStore.getState().conversations[conversationId];
      observed.interactionMode = deriveRunInteractionMode({
        authorizationScopeId: options?.authorizationScopeId,
        runPermissionCeiling: options?.runPermissionCeiling as never,
        triggerId: conversation?.triggerId,
        scheduledTaskId: conversation?.scheduledTaskId,
        initiatedBy: options?.initiatedBy,
      });
      const confirm = options?.commandConfirmCallback ?? requestCommandConfirmation;
      setLoopContext(LOOP_ID, { conversationId } as never);
      try {
        observed.decision = await checkToolApproval(
          toolName,
          input,
          {
            conversationId,
            loopId: LOOP_ID,
            workspacePath: WORKSPACE,
            authorizationScopeId: options?.authorizationScopeId,
            runPermissionCeiling: options?.runPermissionCeiling,
            initiatedBy: options?.initiatedBy,
            interactionMode: observed.interactionMode,
          } as never,
          async (info, loopId) => {
            observed.confirmationAsked = true;
            return confirm(info, loopId);
          },
          options?.filePermissionCallback,
        );
      } finally {
        clearLoopContext(LOOP_ID);
      }
      return { reason: 'completed' };
    },
  );
  return observed;
}

function teamConversation(over: Partial<Conversation>): Conversation {
  return {
    id: CONVERSATION_ID,
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    status: 'idle',
    teamId: 'team-1',
    workspacePath: WORKSPACE,
    messages: [
      { id: 'u1', role: 'user', content: '出一版周报', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '好', timestamp: 2 },
    ],
    ...over,
  };
}

/**
 * A team run continued after a restart starts from the user's click on the
 * interrupted row, so it carries the authority of a human send: attended,
 * no automation ceiling, the conversation's own permission mode.
 */
describe('team run resumed after restart: authority', () => {
  const riskyCommand = { command: 'rm -rf ./drafts', cwd: WORKSPACE };

  beforeEach(() => {
    initLanguage('zh-CN');
    runAgentLoopDispatchedMock.mockReset();
    useTeamConfirmationStore.setState({ pending: {}, approvedOnce: {}, taskRules: {} });
  });

  it('dispatches as a user-initiated, attended run without an automation ceiling', async () => {
    setMigratedBrowserSettings({ permissionMode: 'standard' });
    useChatStore.setState({ conversations: { [CONVERSATION_ID]: teamConversation({}) } } as never);
    const observed = dispatchThroughRealGate(TOOL_NAMES.READ_FILE, { path: `${WORKSPACE}/a.md` });

    await resumeTeamRunAfterRestart(CONVERSATION_ID);

    expect(observed.options?.initiatedBy).toBe('user');
    expect(observed.options?.authorizationScopeId).toBeUndefined();
    expect(observed.options?.runPermissionCeiling).toBeUndefined();
    expect(observed.interactionMode).toBe('foreground');
  });

  it('stays attended in a conversation a schedule created, like any human send into it', async () => {
    setMigratedBrowserSettings({ permissionMode: 'standard' });
    useChatStore.setState({
      conversations: { [CONVERSATION_ID]: teamConversation({ scheduledTaskId: 'task-1' }) },
    } as never);
    const observed = dispatchThroughRealGate(TOOL_NAMES.READ_FILE, { path: `${WORKSPACE}/a.md` });

    await resumeTeamRunAfterRestart(CONVERSATION_ID);

    expect(observed.interactionMode).toBe('foreground');
  });

  it('under standard mode a risky command is refused and queued as a team confirmation, with no dialog', async () => {
    setMigratedBrowserSettings({ permissionMode: 'standard' });
    useChatStore.setState({ conversations: { [CONVERSATION_ID]: teamConversation({}) } } as never);
    const observed = dispatchThroughRealGate(TOOL_NAMES.RUN_COMMAND, riskyCommand);

    await resumeTeamRunAfterRestart(CONVERSATION_ID);

    expect(observed.confirmationAsked).toBe(true);
    expect(observed.decision?.decision).toBe('deny');
    const pending = pendingFor(useTeamConfirmationStore.getState().pending, CONVERSATION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0].detail).toBe(riskyCommand.command);
  });
});
