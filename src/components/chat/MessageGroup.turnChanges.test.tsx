// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, render as renderBare, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useWorkProcessFoldStore } from '@/stores/workProcessFoldStore';
import { __testing as turnChangesCache } from '@/hooks/useTurnChanges';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { Conversation, Message, ToolCall } from '@/types';
import MessageGroup from './MessageGroup';

const mocks = vi.hoisted(() => ({
  readTurnIndex: vi.fn(),
  exists: vi.fn<(path: string) => Promise<boolean>>(),
}));

vi.mock('@/core/session/turnChanges', () => ({
  readTurnIndex: (...args: unknown[]) => mocks.readTurnIndex(...args),
  readTurnChanges: vi.fn(async () => null),
  onTurnChangesSaved: () => () => {},
}));

vi.mock('@/core/tools/fsBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/tools/fsBridge')>()),
  exists: (path: string) => mocks.exists(path),
}));

vi.mock('@/core/session/outputSnapshots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/session/outputSnapshots')>()),
  resolveFileSource: vi.fn(async (_conversationId: unknown, filePath: string) => ({
    status: 'available', path: filePath, isFromSnapshot: false,
  })),
}));

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const CONVERSATION_ID = 'conversation-turn-changes';

function turn(options: { toolCalls?: ToolCall[]; runState?: Message['runState'] } = {}): Message[] {
  return [
    { id: 'user', role: 'user', content: 'edit the plan', timestamp: 1_000, loopId: 'loop', runState: options.runState ?? 'completed', runEndedAt: 3_000 },
    { id: 'work', role: 'assistant', content: '', timestamp: 2_000, loopId: 'loop', toolCalls: options.toolCalls ?? [], fileCards: 'declared' },
    { id: 'answer', role: 'assistant', content: 'Done.', timestamp: 2_500, loopId: 'loop', fileCards: 'declared' },
  ];
}

function setConversation(messages: Message[], status: Conversation['status'] = 'idle') {
  const conversation: Conversation = {
    id: CONVERSATION_ID, title: 'Changes', messages, createdAt: 1_000, updatedAt: 3_000, status,
  };
  useChatStore.setState({
    activeConversationId: conversation.id,
    conversations: { [conversation.id]: conversation },
    agentStates: new Map(),
  });
}

const changedFilesCard = () => screen.queryByTestId('changed-files-card');

describe('MessageGroup changed-files card', () => {
  beforeEach(() => {
    initLanguage('en-US');
    turnChangesCache.reset();
    mocks.readTurnIndex.mockReset();
    mocks.readTurnIndex.mockResolvedValue({ loop: { total: 1, added: 3, deleted: 3, firstFile: 'plan.md' } });
    mocks.exists.mockReset();
    mocks.exists.mockResolvedValue(true);
    usePreviewStore.setState({
      tabs: [], currentConversationId: CONVERSATION_ID, activeTabId: null,
      panelStateByConversation: {}, lastActiveTabByConversation: {},
    });
  });

  afterEach(() => {
    useWorkProcessFoldStore.getState().reset();
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the card under the reply of a finished turn', async () => {
    const messages = turn();
    setConversation(messages);
    render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup isLastGroupOfLoop />);

    expect(await screen.findByRole('button', { name: /^Edited plan\.md/ })).toBeInTheDocument();
    expect(mocks.readTurnIndex).toHaveBeenCalledWith(CONVERSATION_ID);
  });

  it('shows no card while the run of the last group is still going, and shows it once the run has ended', async () => {
    const messages = turn();
    setConversation(messages, 'running');
    render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup isLastGroupOfLoop />);
    await act(async () => {});
    expect(changedFilesCard()).toBeNull();
    expect(mocks.readTurnIndex).not.toHaveBeenCalled();

    act(() => setConversation(messages, 'idle'));
    await waitFor(() => expect(changedFilesCard()).not.toBeNull());
  });

  it('shows no card in a group that is not the last one of its loop', async () => {
    const messages = turn();
    setConversation(messages);
    render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroupOfLoop={false} />);
    await act(async () => {});
    expect(changedFilesCard()).toBeNull();
    expect(mocks.readTurnIndex).not.toHaveBeenCalled();
  });

  it.each(['interrupted', 'failed'] as const)('shows the card for a turn that ended %s', async (runState) => {
    const messages = turn({ runState });
    setConversation(messages);
    render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup isLastGroupOfLoop />);
    await waitFor(() => expect(changedFilesCard()).not.toBeNull());
  });

  it('shows no card for a turn the index does not list', async () => {
    mocks.readTurnIndex.mockResolvedValue({});
    const messages = turn();
    setConversation(messages);
    render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup isLastGroupOfLoop />);
    await waitFor(() => expect(mocks.readTurnIndex).toHaveBeenCalled());
    await act(async () => {});
    expect(changedFilesCard()).toBeNull();
  });

  it('puts the card after the cards of the files the turn presented', async () => {
    const present: ToolCall = {
      id: 'present',
      name: TOOL_NAMES.PRESENT_FILES,
      input: { files: [{ path: '/ws/report.md' }] },
      result: 'Presented /ws/report.md',
    };
    const messages = turn({ toolCalls: [present] });
    setConversation(messages);
    render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup isLastGroupOfLoop />);

    const fileCard = await screen.findByTitle('Click to preview');
    const card = await screen.findByTestId('changed-files-card');
    expect(fileCard.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
