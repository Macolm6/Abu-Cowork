// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render as renderBare, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { useWorkProcessFoldStore } from '@/stores/workProcessFoldStore';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { Conversation, Message } from '@/types';
import type { ExecutionStep } from '@/types/execution';
import MessageGroup from './MessageGroup';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const LOOP_ID = 'loop-waiting';

function step(execId: string, id: string, toolName: string, type: ExecutionStep['type'], status: ExecutionStep['status']): ExecutionStep {
  return {
    id,
    executionId: execId,
    toolCallId: id,
    type,
    label: `${toolName} ${id}`,
    status,
    toolName,
    toolInput: {},
    source: 'agent',
    detailBlocks: [],
  };
}

// The turn read two files and is now blocked on ask_user_question. MessageGroup
// hands TaskBlock no live signal for that wait (no spinner), so the header's
// wording comes from the settled path: it must still say the turn waits.
describe('MessageGroup — a turn waiting for the answer to its question', () => {
  beforeEach(() => {
    initLanguage('en-US');
    useTaskExecutionStore.setState({ executions: {}, activeExecutionId: null, loopIdIndex: {} });
    useWorkProcessFoldStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    useTaskExecutionStore.setState({ executions: {}, activeExecutionId: null, loopIdIndex: {} });
    useWorkProcessFoldStore.getState().reset();
  });

  it('titles the block with the wait, without a spinner, over the counts of the finished reads', () => {
    const t = getI18n();
    const userMessage: Message = {
      id: 'user-waiting',
      role: 'user',
      content: 'tidy the notes',
      timestamp: 1_000,
      loopId: LOOP_ID,
      runState: 'running',
    };
    const assistantMessage: Message = {
      id: 'assistant-waiting',
      role: 'assistant',
      content: '',
      timestamp: 1_500,
      loopId: LOOP_ID,
      toolCalls: [
        { id: 'read-1', name: TOOL_NAMES.READ_FILE, input: { path: '/notes/a.md' }, result: 'a' },
        { id: 'read-2', name: TOOL_NAMES.READ_FILE, input: { path: '/notes/b.md' }, result: 'b' },
        { id: 'ask-1', name: TOOL_NAMES.ASK_USER_QUESTION, input: { questions: [{ question: 'Which notes?' }] }, isExecuting: true },
      ],
    };
    const conversation: Conversation = {
      id: 'conversation-waiting',
      title: 'Waiting',
      messages: [userMessage, assistantMessage],
      createdAt: 1_000,
      updatedAt: 1_500,
      status: 'running',
    };
    useChatStore.setState({
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      agentStates: new Map(),
    });
    useChatStore.getState().setAgentStatus(conversation.id, 'tool-calling');

    const execution = useTaskExecutionStore.getState().createExecution(conversation.id, LOOP_ID);
    const store = useTaskExecutionStore.getState();
    store.addStep(execution.id, step(execution.id, 'read-1', TOOL_NAMES.READ_FILE, 'file-read', 'completed'));
    store.addStep(execution.id, step(execution.id, 'read-2', TOOL_NAMES.READ_FILE, 'file-read', 'completed'));
    store.addStep(execution.id, step(execution.id, 'ask-1', TOOL_NAMES.ASK_USER_QUESTION, 'tool', 'running'));

    const { container } = render(
      <MessageGroup conversationId={conversation.id} messages={conversation.messages} isLastGroup />,
    );

    const header = container.querySelector('.task-block > button');
    expect(header).not.toBeNull();
    expect(header!.textContent).toBe(t.userQuestion.waitingForAnswer);
    expect(header!.querySelector('[data-ds-spinner]')).toBeNull();
    expect(screen.queryByText(/Read 2 files/)).toBeNull();
  });
});
