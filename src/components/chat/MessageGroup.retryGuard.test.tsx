// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useToastStore } from '@/stores/toastStore';
import { useWorkProcessFoldStore } from '@/stores/workProcessFoldStore';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import type { Conversation, Message } from '@/types';
import MessageGroup from './MessageGroup';

// The action row's icon buttons carry ds tooltips, which need the provider the app mounts at its root.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: vi.fn(),
}));

vi.mock('@/core/session/outputSnapshots', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/core/session/outputSnapshots')>(),
  resolveFileSource: vi.fn().mockResolvedValue({ status: 'missing', basename: 'x', originalPath: '/tmp/x' }),
}));

describe('MessageGroup retry when the conversation pinned model is no longer usable', () => {
  let deleteSpy: MockInstance | undefined;

  beforeEach(() => {
    initLanguage('en-US');
    vi.mocked(runAgentLoopDispatched).mockReset();
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useSettingsStore.setState((state) => ({
      providers: state.providers.map((provider) =>
        provider.id === 'anthropic' ? { ...provider, enabled: true, apiKey: 'test-key' } : provider,
      ),
    }));
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    useToastStore.setState(useToastStore.getInitialState(), true);
  });

  afterEach(() => {
    deleteSpy?.mockRestore();
    deleteSpy = undefined;
    useToastStore.setState(useToastStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState(useEnterpriseStore.getInitialState(), true);
    useWorkProcessFoldStore.getState().reset();
    cleanup();
  });

  it('refuses the assistant-side retry before rewinding or dispatching', () => {
    const userMessage: Message = {
      id: 'user-1', role: 'user', content: 'do the thing', timestamp: 1_000, loopId: 'loop-1', runState: 'completed', runEndedAt: 3_000,
    };
    const assistantMessage: Message = {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 2_000,
      loopId: 'loop-1',
      toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: '/tmp/a' }, result: 'Error: boom' }],
      executionSteps: [{
        id: 'step-1', toolCallId: 'call-1', type: 'tool', label: 'Read file', status: 'error', toolName: 'read_file',
      }],
    };
    // A later turn means an unguarded retry would ask to rewind it first.
    const laterTurn: Message = { id: 'user-2', role: 'user', content: 'next', timestamp: 4_000, loopId: 'loop-2' };
    const conversation: Conversation = {
      id: 'conversation-1',
      title: 'Failed task',
      messages: [userMessage, assistantMessage, laterTurn],
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
      model: { providerId: 'gone-provider', modelId: 'model-a' },
    };
    useChatStore.setState({
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      agentStates: new Map(),
    });
    deleteSpy = vi.spyOn(useChatStore.getState(), 'deleteMessagesFrom');
    const before = useChatStore.getState().conversations[conversation.id].messages;

    render(<MessageGroup conversationId={conversation.id} messages={[userMessage, assistantMessage]} isLastGroup />);
    // The failed step block starts collapsed; open it to reach its Retry control.
    fireEvent.click(screen.getByText('Called tool').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: getI18n().task.retryAction }));

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(useChatStore.getState().conversations[conversation.id].messages).toBe(before);
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'error', title: expect.stringContaining('model-a') }),
    ]);
    expect(screen.queryByText(getI18n().chat.redoRetryTitle)).not.toBeInTheDocument();
  });
});

describe('MessageGroup retry question', () => {
  const CONVERSATION = 'conversation-1';
  const userMessage: Message = {
    id: 'user-1', role: 'user', content: 'do the thing', timestamp: 1_000, loopId: 'loop-1', runState: 'completed', runEndedAt: 3_000,
  };
  const assistantMessage: Message = {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    timestamp: 2_000,
    loopId: 'loop-1',
    toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: '/fake/project/a' }, result: 'Error: boom' }],
    executionSteps: [{
      id: 'step-1', toolCallId: 'call-1', type: 'tool', label: 'Read file', status: 'error', toolName: 'read_file',
    }],
  };
  const laterTurn: Message = { id: 'user-2', role: 'user', content: 'next', timestamp: 4_000, loopId: 'loop-2' };
  let deleteSpy: MockInstance;

  function seed(messages: Message[]) {
    const conversation: Conversation = {
      id: CONVERSATION,
      title: 'Failed task',
      messages,
      createdAt: 1_000,
      updatedAt: 3_000,
      status: 'idle',
      model: { providerId: 'anthropic', modelId: 'model-a' },
    };
    useChatStore.setState({
      activeConversationId: conversation.id,
      conversations: { [conversation.id]: conversation },
      agentStates: new Map(),
    });
    deleteSpy = vi.spyOn(useChatStore.getState(), 'deleteMessagesFrom');
  }
  const stored = () => useChatStore.getState().conversations[CONVERSATION].messages;
  const questionTitle = () => screen.queryByText(getI18n().chat.redoRetryTitle);
  // The question opens once the files of the turns it would delete have been looked at.
  const asked = () => screen.findByText(getI18n().chat.redoRetryTitle);
  const confirm = () => fireEvent.click(screen.getByRole('button', { name: getI18n().chat.redoRetryConfirm }));
  const answered = () => act(async () => {});
  const sentWith = (content: string) => [CONVERSATION, content, { initiatedBy: 'user', startHold: expect.objectContaining({ conversationId: CONVERSATION }) }];
  // A retry that asks nothing starts once the files have been looked at.
  const started = () => waitFor(() => expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1));
  function pressRetry() {
    // The failed step block starts collapsed; open it to reach its Retry control.
    fireEvent.click(screen.getByText('Called tool').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: getI18n().task.retryAction }));
  }

  beforeEach(() => {
    initLanguage('en-US');
    vi.mocked(runAgentLoopDispatched).mockReset();
    vi.mocked(runAgentLoopDispatched).mockResolvedValue({ reason: 'completed' });
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useSettingsStore.setState((state) => ({
      providers: state.providers.map((provider) =>
        provider.id === 'anthropic'
          ? { ...provider, enabled: true, apiKey: 'test-key', models: [...provider.models, { ...provider.models[0], id: 'model-a', label: '' }] }
          : provider,
      ),
    }));
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    useToastStore.setState(useToastStore.getInitialState(), true);
  });

  afterEach(() => {
    deleteSpy.mockRestore();
    useToastStore.setState(useToastStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState(useEnterpriseStore.getInitialState(), true);
    useWorkProcessFoldStore.getState().reset();
    cleanup();
  });

  it('retries at once, with no question, when no turn follows', async () => {
    seed([userMessage, assistantMessage]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    await started();

    expect(questionTitle()).not.toBeInTheDocument();
    // The cut starts at the user message: the run writes that message anew.
    expect(deleteSpy.mock.calls).toEqual([[CONVERSATION, userMessage.id]]);
    expect(stored()).toEqual([]);
    expect(runAgentLoopDispatched).toHaveBeenCalledWith(...sentWith('do the thing'));
  });

  it('keeps the earlier turns and cuts at the user message of the retried turn', async () => {
    const earlierUser: Message = { id: 'user-0', role: 'user', content: 'before', timestamp: 100, loopId: 'loop-0' };
    const earlierReply: Message = { id: 'assistant-0', role: 'assistant', content: 'done', timestamp: 200, loopId: 'loop-0' };
    seed([earlierUser, earlierReply, userMessage, assistantMessage]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    await started();

    expect(deleteSpy.mock.calls).toEqual([[CONVERSATION, userMessage.id]]);
    expect(stored()).toEqual([earlierUser, earlierReply]);
  });

  it('keeps an earlier question and its answer that share the loop id of the retried one', async () => {
    const earlierUser: Message = { id: 'user-0', role: 'user', content: 'before', timestamp: 100, loopId: userMessage.loopId };
    const earlierReply: Message = { id: 'assistant-0', role: 'assistant', content: 'done', timestamp: 200, loopId: userMessage.loopId };
    seed([earlierUser, earlierReply, userMessage, assistantMessage]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    await started();

    expect(deleteSpy.mock.calls).toEqual([[CONVERSATION, userMessage.id]]);
    expect(stored()).toEqual([earlierUser, earlierReply]);
  });

  it('sends a turn that went to an expert to that expert again', async () => {
    const routed: Message = { ...userMessage, delegateAgent: { name: 'researcher', description: 'Researcher' } };
    seed([routed, assistantMessage]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[routed, assistantMessage]} isLastGroup />);

    pressRetry();
    await started();

    expect(runAgentLoopDispatched).toHaveBeenCalledWith(...sentWith('@researcher do the thing'));
  });

  it('sends a turn that ran a skill to that skill again', async () => {
    const routed: Message = { ...userMessage, skill: { name: 'pdf', description: 'PDF skill' } };
    seed([routed, assistantMessage]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[routed, assistantMessage]} isLastGroup />);

    pressRetry();
    await started();

    expect(runAgentLoopDispatched).toHaveBeenCalledWith(...sentWith('/pdf do the thing'));
  });

  it('asks with the number of turns that follow, and Cancel deletes nothing', async () => {
    seed([userMessage, assistantMessage, laterTurn]);
    const before = stored();
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    expect(await asked()).toBeInTheDocument();
    expect(screen.getByText(getI18n().chat.redoLaterTurns.replace('{count}', '1'))).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: getI18n().common.cancel }));
    await answered();
    expect(questionTitle()).not.toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  it('deletes and sends once after Confirm', async () => {
    seed([userMessage, assistantMessage, laterTurn]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    await asked();
    confirm();
    await answered();

    expect(questionTitle()).not.toBeInTheDocument();
    expect(deleteSpy.mock.calls).toEqual([[CONVERSATION, userMessage.id]]);
    expect(stored()).toEqual([]);
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    expect(runAgentLoopDispatched).toHaveBeenCalledWith(...sentWith('do the thing'));
  });

  it('asks in a question window that opens on Cancel', async () => {
    seed([userMessage, assistantMessage, laterTurn]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();

    expect(await screen.findByRole('alertdialog', { name: getI18n().chat.redoRetryTitle })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: getI18n().common.cancel })).toHaveFocus());
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  });

  it('deletes nothing when the turn has left the conversation by the time of the answer', async () => {
    seed([userMessage, assistantMessage, laterTurn]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    await asked();
    act(() => {
      useChatStore.setState((state) => ({
        conversations: { [CONVERSATION]: { ...state.conversations[CONVERSATION], messages: [laterTurn] } },
      }));
    });
    const before = stored();
    confirm();
    await answered();

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  const setStatus = (status: Conversation['status']) => act(() => {
    useChatStore.setState((state) => ({
      conversations: { [CONVERSATION]: { ...state.conversations[CONVERSATION], status } },
    }));
  });

  it('deletes nothing when a run has started on the conversation by the time of the answer', async () => {
    seed([userMessage, assistantMessage, laterTurn]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    await asked();
    setStatus('running');
    const before = stored();
    confirm();
    await answered();

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  // A redo cuts the conversation and may restore files, so like every other redo entry the
  // step retry waits until the conversation is at rest.
  it('offers no step retry while the conversation runs', () => {
    seed([userMessage, assistantMessage, laterTurn]);
    setStatus('running');
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    // Open the failed step block, where its Retry control sits.
    fireEvent.click(screen.getByText('Called tool').closest('button')!);

    expect(screen.getByText('Read file')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: getI18n().task.retryAction })).not.toBeInTheDocument();
  });

  it('deletes nothing when more turns follow at the answer than the question named', async () => {
    seed([userMessage, assistantMessage, laterTurn]);
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    pressRetry();
    await asked();
    const another: Message = { id: 'user-3', role: 'user', content: 'and more', timestamp: 5_000, loopId: 'loop-3' };
    act(() => {
      useChatStore.setState((state) => ({
        conversations: { [CONVERSATION]: { ...state.conversations[CONVERSATION], messages: [userMessage, assistantMessage, laterTurn, another] } },
      }));
    });
    const before = stored();
    confirm();
    await answered();

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });
});
