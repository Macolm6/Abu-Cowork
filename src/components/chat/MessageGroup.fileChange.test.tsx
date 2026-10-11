// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { format, getI18n, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useWorkProcessFoldStore } from '@/stores/workProcessFoldStore';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { Conversation, Message, ToolCall } from '@/types';
import MessageGroup from './MessageGroup';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const CONVERSATION_ID = 'conversation-file-change';
const PATH = '/ws/plan.md';

const editCall: ToolCall = {
  id: 'tc-edit',
  name: TOOL_NAMES.EDIT_FILE,
  input: { path: PATH, old_content: 'two', new_content: '2' },
  result: `Successfully edited ${PATH}: replaced 1 line(s) with 1 line(s)`,
  fileChange: {
    path: PATH,
    kind: 'modify',
    added: 1,
    deleted: 1,
    hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' one', '-two', '+2', ' three'] }],
  },
};

/** A finished turn as it is loaded from disk: the steps come from the saved snapshot. */
function savedTurn(toolCalls: ToolCall[]): Message[] {
  return [
    { id: 'user', role: 'user', content: 'fix the plan', timestamp: 1_000, loopId: 'loop', runState: 'completed', runEndedAt: 3_000 },
    {
      id: 'work',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: 'loop',
      toolCalls,
      executionSteps: [{
        id: 'step-edit',
        toolCallId: 'tc-edit',
        type: 'file-write',
        label: 'Edit plan.md',
        status: 'completed',
        toolName: TOOL_NAMES.EDIT_FILE,
      }],
    },
    { id: 'answer', role: 'assistant', content: 'Done.', timestamp: 2_500, loopId: 'loop' },
  ];
}

function setConversation(messages: Message[]) {
  const conversation: Conversation = {
    id: CONVERSATION_ID, title: 'Plan', messages, createdAt: 1_000, updatedAt: 3_000, status: 'idle',
  };
  useChatStore.setState({
    activeConversationId: conversation.id,
    conversations: { [conversation.id]: conversation },
    agentStates: new Map(),
  });
}

/** Opens the settled turn's process, then the step block inside it. */
function openSteps() {
  fireEvent.click(screen.getByRole('button', { name: /Worked for/ }));
  fireEvent.click(screen.getByRole('button', { name: getI18n().task.modifiedFile }));
}

describe('MessageGroup file change of a saved step', () => {
  const originalOpenPreview = usePreviewStore.getState().openPreview;
  const openPreview = vi.fn();

  beforeEach(() => {
    initLanguage('en-US');
    openPreview.mockReset();
    usePreviewStore.setState({ openPreview });
  });

  afterEach(() => {
    useWorkProcessFoldStore.getState().reset();
    cleanup();
    usePreviewStore.setState({ openPreview: originalOpenPreview });
  });

  it('shows the counts, the diff and the file link from the tool call paired with the saved step', () => {
    const messages = savedTurn([editCall]);
    setConversation(messages);

    const { container } = render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);
    openSteps();

    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('−1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '+1 −1' }));
    expect(container.querySelectorAll('[data-diff-row]')).toHaveLength(4);
    expect(container.querySelector('[data-diff-row="deleted"]')).toHaveTextContent('two');
    expect(container.querySelector('[data-diff-row="added"]')).toHaveTextContent('2');

    fireEvent.click(screen.getByRole('button', { name: format(getI18n().chat.openFileInPreview, { name: 'plan.md' }) }));
    expect(openPreview).toHaveBeenCalledWith(PATH);
  });

  it('shows the step as before when its tool call holds no file change', () => {
    const { fileChange: _fileChange, ...plainCall } = editCall;
    const messages = savedTurn([plainCall]);
    setConversation(messages);

    render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);
    openSteps();

    expect(screen.getByText('Edit plan.md')).toBeInTheDocument();
    expect(screen.queryByText('+1')).toBeNull();
    expect(screen.queryByRole('button', { name: format(getI18n().chat.openFileInPreview, { name: 'plan.md' }) })).toBeNull();
  });
});
