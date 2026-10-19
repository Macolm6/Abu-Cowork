// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, Fragment, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DesignSystemProvider } from '@/components/ds/provider';
import ToasterMount from '@/components/common/ToasterMount';
import { passSettleInterval } from '@/test/dsWindows';
import { getLanguageSetting, initLanguage, type LanguageSetting } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useBackgroundCommandStore } from '@/stores/backgroundCommandStore';
import { useToastStore } from '@/stores/toastStore';
import { useConversationRowFocus } from './conversationRowFocus';
import { useDeleteConversation } from './useDeleteConversation';
import * as conversationStorage from '@/core/session/conversationStorage';

// The disk read is the boundary: a test makes one record unreadable.
vi.mock('@/core/session/conversationStorage', async () => {
  const actual = await vi.importActual<typeof import('@/core/session/conversationStorage')>('@/core/session/conversationStorage');
  return { ...actual, loadMessages: vi.fn(actual.loadMessages) };
});

// The main process as the renderer sees it: running background commands per conversation.
const running = new Map<string, number>();

function fakeMainProcess() {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const conversationId = (args as { conversationId?: string } | undefined)?.conversationId ?? '';
    switch (cmd) {
      case 'background_command_running_count':
        return running.get(conversationId) ?? 0;
      case 'background_command_stop_conversation':
        running.delete(conversationId);
        return null;
      case 'background_command_list':
        return Array.from({ length: running.get(conversationId) ?? 0 }, (_, index) => ({
          id: `cmd-${index}`,
          command: 'npm run dev',
          cwd: '/work',
          status: 'running',
          exitCode: null,
          startedAt: 1,
          finishedAt: null,
        }));
      default:
        return undefined;
    }
  });
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(DesignSystemProvider, null, createElement(Fragment, null, children, createElement(ToasterMount)));
}

function renderDeletion() {
  return renderHook(() => useDeleteConversation(useConversationRowFocus(), true), { wrapper });
}

/** Chooses 删除会话 in the row menu, and the menu goes. */
async function deleteFromMenu(deletion: ReturnType<typeof useDeleteConversation>, convId: string) {
  await act(async () => {
    deletion.fromMenu(convId);
    deletion.menuClosed();
  });
}

const offer = () => within(screen.getByRole('region', { name: '通知' })).queryByText('会话已删除')?.closest('li') ?? null;

function clearNotices() {
  for (const toast of useToastStore.getState().toasts) useToastStore.getState().removeToast(toast.id);
}

describe('useDeleteConversation and background commands', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    running.clear();
    fakeMainProcess();
    clearNotices();
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null, loadFailures: {} });
    useBackgroundCommandStore.setState({ rows: {} });
  });

  afterEach(() => {
    act(() => clearNotices());
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.restoreAllMocks();
  });

  it('asks before deleting a conversation with running background commands', async () => {
    const user = userEvent.setup();
    const id = useChatStore.getState().createConversation();
    running.set(id, 1);
    const { result } = renderDeletion();

    await deleteFromMenu(result.current, id);

    const question = await screen.findByRole('alertdialog');
    expect(within(question).getByText('这段对话还有 1 个后台命令在运行')).toBeInTheDocument();
    expect(within(question).getByText('删除后会停止它们。撤销删除只能恢复对话。')).toBeInTheDocument();
    expect(within(question).getByRole('button', { name: '删除' })).toHaveClass('text-danger');
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);

    passSettleInterval();
    await user.click(within(question).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    expect(useChatStore.getState().conversations[id]).toBeDefined();
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'background_command_stop_conversation')).toEqual([]);
    expect(running.get(id)).toBe(1);
    expect(offer()).toBeNull();
  });

  it('deletes at once without running background commands', async () => {
    const id = useChatStore.getState().createConversation();
    const { result } = renderDeletion();

    await deleteFromMenu(result.current, id);

    await waitFor(() => expect(useChatStore.getState().conversations[id]).toBeUndefined());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useToastStore.getState().toasts.map((toast) => [toast.title, toast.actions?.map((action) => action.label)]))
      .toEqual([['会话已删除', ['撤销']]]);
  });

  it('asks once, naming the stop, for an unreadable conversation with running background commands', async () => {
    const user = userEvent.setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(conversationStorage.loadMessages).mockRejectedValueOnce(new Error('disk unavailable'));
    const id = 'c-unreadable';
    useChatStore.setState({
      conversationIndex: { [id]: { id, title: 'Quarterly summary', createdAt: 1, updatedAt: 1, messageCount: 2 } },
    });
    running.set(id, 1);
    const { result } = renderDeletion();

    await deleteFromMenu(result.current, id);

    const question = await screen.findByRole('alertdialog');
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(within(question).getByText('这段对话还有 1 个后台命令在运行')).toBeInTheDocument();
    expect(within(question).getByText('「Quarterly summary」的记录目前读不出来，删除后无法恢复，也会停止这些命令。')).toBeInTheDocument();

    passSettleInterval();
    await user.click(within(question).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(useChatStore.getState().conversationIndex[id]).toBeUndefined());
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'background_command_stop_conversation'))
      .toEqual([['background_command_stop_conversation', { conversationId: id }]]);
    expect(offer()).toBeNull();
  });

  describe('in English', () => {
    let previousLanguage: LanguageSetting;
    beforeEach(() => {
      previousLanguage = getLanguageSetting();
      initLanguage('en-US');
    });
    afterEach(() => { initLanguage(previousLanguage); });

    it('words one running command in the singular', async () => {
      const id = useChatStore.getState().createConversation();
      running.set(id, 1);
      const { result } = renderDeletion();

      await deleteFromMenu(result.current, id);

      const question = await screen.findByRole('alertdialog');
      expect(within(question).getByText('1 background command is still running in this conversation')).toBeInTheDocument();
      expect(within(question).getByText('Deleting stops it. Undo brings back only the conversation.')).toBeInTheDocument();
    });

    it('words one running command of an unreadable conversation in the singular', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.mocked(conversationStorage.loadMessages).mockRejectedValueOnce(new Error('disk unavailable'));
      const id = 'c-unreadable';
      useChatStore.setState({
        conversationIndex: { [id]: { id, title: 'Quarterly summary', createdAt: 1, updatedAt: 1, messageCount: 2 } },
      });
      running.set(id, 1);
      const { result } = renderDeletion();

      await deleteFromMenu(result.current, id);

      const question = await screen.findByRole('alertdialog');
      expect(within(question).getByText('1 background command is still running in this conversation')).toBeInTheDocument();
      expect(within(question).getByText(
        'The record of "Quarterly summary" can\'t be read right now. Deleting it can\'t be undone, and it also stops this command.',
      )).toBeInTheDocument();
    });

    it('words two running commands in the plural', async () => {
      const id = useChatStore.getState().createConversation();
      running.set(id, 2);
      const { result } = renderDeletion();

      await deleteFromMenu(result.current, id);

      const question = await screen.findByRole('alertdialog');
      expect(within(question).getByText('2 background commands are still running in this conversation')).toBeInTheDocument();
      expect(within(question).getByText('Deleting stops them. Undo brings back only the conversation.')).toBeInTheDocument();
    });
  });

  it('reads the count again when the question waited for the menu', async () => {
    const id = useChatStore.getState().createConversation();
    running.set(id, 1);
    const { result } = renderDeletion();
    const counts = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'background_command_running_count').length;

    // The menu is still closing when the count arrives: the question waits for its close hook.
    await act(async () => { result.current.fromMenu(id); });
    expect(counts()).toBe(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useChatStore.getState().conversations[id]).toBeDefined();

    // The commands ended meanwhile.
    running.delete(id);
    await act(async () => { result.current.menuClosed(); });

    await waitFor(() => expect(useChatStore.getState().conversations[id]).toBeUndefined());
    expect(counts()).toBe(2);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(offer()).not.toBeNull();
  });

  it('undo restores the conversation without its background commands', async () => {
    const user = userEvent.setup();
    const id = useChatStore.getState().createConversation();
    running.set(id, 2);
    const { result } = renderDeletion();

    await deleteFromMenu(result.current, id);
    const question = await screen.findByRole('alertdialog');
    expect(within(question).getByText('这段对话还有 2 个后台命令在运行')).toBeInTheDocument();
    passSettleInterval();
    await user.click(within(question).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(useChatStore.getState().conversations[id]).toBeUndefined());
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'background_command_stop_conversation'))
      .toEqual([['background_command_stop_conversation', { conversationId: id }]]);
    expect(offer()).not.toBeNull();

    passSettleInterval();
    await user.click(within(offer()!).getByRole('button', { name: '撤销' }));

    // The undo brings the conversation back under a new id.
    const restored = Object.keys(useChatStore.getState().conversations);
    expect(restored).toHaveLength(1);
    for (const conversationId of [id, restored[0]]) {
      await useBackgroundCommandStore.getState().refresh(conversationId);
      expect(useBackgroundCommandStore.getState().rows[conversationId]).toEqual([]);
    }
  });
});
