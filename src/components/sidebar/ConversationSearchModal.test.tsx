// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useProjectStore } from '@/stores/projectStore';
import type { Project } from '@/types/project';
import ConversationSearchModal from './ConversationSearchModal';

const mocks = vi.hoisted(() => ({
  chat: {} as Record<string, unknown>,
  catalogSearch: vi.fn(),
}));

vi.mock('@/stores/chatStore', () => {
  const useChatStore = (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.chat);
  useChatStore.getState = () => mocks.chat;
  return { useChatStore };
});
vi.mock('@/core/session/conversationStorage', () => ({ catalogSearch: mocks.catalogSearch }));

const conv = (id: string, title: string, createdAt: number, extra: Record<string, unknown> = {}) =>
  ({ id, title, createdAt, updatedAt: createdAt, messageCount: 1, ...extra });

const project = (id: string, name: string, archived = false): Project =>
  ({ id, name, workspacePath: `/work/${id}`, pinned: false, archived, createdAt: 0, updatedAt: 0, lastActiveAt: 0 });

const hit = (conv_id: string, title: string, snippet: string) => ({ conv_id, title, snippet, rank: 0 });

// The line under a result's title: the project's name and the matching passage.
const detailOf = (title: string) => {
  const id = screen.getByRole('button', { name: title }).getAttribute('aria-describedby');
  return id ? document.getElementById(id) : null;
};

function renderSearch(onClose: () => void = vi.fn()) {
  return render(<ConversationSearchModal open onClose={onClose} />, { wrapper: DesignSystemProvider });
}

beforeEach(() => {
  initLanguage('zh-CN');
  mocks.catalogSearch.mockReset();
  mocks.catalogSearch.mockResolvedValue([]);
  useProjectStore.setState({ projects: {}, expandedProjectIds: [], revealConversationId: null });
  mocks.chat = {
    conversationIndex: {
      a: conv('a', 'Quarterly report', 3),
      b: conv('b', 'Travel plan', 2),
      c: conv('c', 'Report draft', 1),
    },
    switchConversation: vi.fn(),
    clearCompletedStatus: vi.fn(),
    setPendingSearchJump: vi.fn(),
  };
});
afterEach(() => cleanup());

describe('ConversationSearchModal', () => {
  it('closes on Escape even before the search input receives focus', () => {
    const onClose = vi.fn();

    renderSearch(onClose);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens as a design-system dialog with the field focused and recent tasks listed', () => {
    renderSearch();
    const dialog = screen.getByRole('dialog', { name: '搜索' });
    expect(dialog).toHaveAttribute('data-ds-layer');
    // 「搜索」 names the dialog for screen readers but is not shown: the field says it.
    expect(within(dialog).getByText('搜索')).not.toHaveClass('text-title');
    expect(within(dialog).getByText('搜索').style.position).toBe('absolute');
    expect(within(dialog).getByPlaceholderText('搜索对话...')).toHaveFocus();
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Quarterly report', 'Travel plan', 'Report draft',
    ]);
  });

  it('opens the first match with Enter', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderSearch(onClose);
    await user.type(screen.getByPlaceholderText('搜索对话...'), 'report{Enter}');
    expect(mocks.chat.switchConversation).toHaveBeenCalledWith('a');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('orders recent tasks and name matches by the last user message time', async () => {
    const user = userEvent.setup();
    mocks.chat.conversationIndex = {
      newer: conv('newer', 'Report newer', 500, { lastUserMessageAt: 500 }),
      older: conv('older', 'Report older', 100, { lastUserMessageAt: 900 }),
    };
    renderSearch();
    const titles = () => within(screen.getByRole('dialog')).getAllByRole('button').map((button) => button.textContent);
    expect(titles()).toEqual(['Report older', 'Report newer']);
    await user.type(screen.getByPlaceholderText('搜索对话...'), 'report');
    expect(titles()).toEqual(['Report older', 'Report newer']);
  });

  it('moves between the field and the results with the arrow keys, and Enter opens the focused one', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderSearch(onClose);
    const field = screen.getByPlaceholderText('搜索对话...');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Quarterly report' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Travel plan' })).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(field).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(mocks.chat.switchConversation).toHaveBeenCalledWith('b');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByPlaceholderText('搜索对话...'), 'zzz');
    expect(screen.getByText('没有匹配的对话')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: /report|plan/i })).toBeNull();
  });

  it('sizes the results to their content and keeps the top edge still while typing', () => {
    renderSearch();
    const dialog = screen.getByRole('dialog');
    // Each result sits in a box of its own, which also holds the line under its title.
    const results = within(dialog).getByRole('button', { name: 'Quarterly report' }).parentElement?.parentElement as HTMLElement;
    // A maximum height, then scrolling; never a fixed height that leaves an empty area.
    expect(results).toHaveClass('max-h-80', 'overflow-y-auto');
    expect(results).not.toHaveClass('h-80');
    expect(dialog).toHaveClass('top-1/7');
  });

  describe('conversations of a project', () => {
    beforeEach(() => {
      useProjectStore.setState({
        projects: { p1: project('p1', 'Sales 2026'), old: project('old', 'Archived work', true) },
      });
      mocks.chat.conversationIndex = {
        a: conv('a', 'Quarterly report', 6),
        p: conv('p', 'Report cleanup', 5, { projectId: 'p1' }),
        q: conv('q', 'Pricing notes', 4, { projectId: 'p1' }),
        s: conv('s', 'Report of the nightly run', 3, { scheduledTaskId: 'task1' }),
        g: conv('g', 'Report on a new file', 2, { triggerId: 'trigger1' }),
        o: conv('o', 'Report from last year', 1, { projectId: 'old' }),
      };
    });

    it('lists them among the recent conversations with the project named under the title', () => {
      renderSearch();
      expect(within(screen.getByRole('dialog')).getAllByRole('button').map((b) => b.textContent)).toEqual([
        'Quarterly report', 'Report cleanup', 'Pricing notes',
      ]);
      expect(detailOf('Report cleanup')).toHaveTextContent('Sales 2026');
      expect(detailOf('Quarterly report')).toBeNull();
    });

    it('finds one by its title and leaves out background runs and archived projects', async () => {
      const user = userEvent.setup();
      renderSearch();
      await user.type(screen.getByPlaceholderText('搜索对话...'), 'report');
      expect(within(screen.getByRole('dialog')).getAllByRole('button').map((b) => b.textContent)).toEqual([
        'Quarterly report', 'Report cleanup',
      ]);
      expect(detailOf('Report cleanup')).toHaveTextContent('Sales 2026');
    });

    it('finds every conversation of a project by the project\'s name', async () => {
      const user = userEvent.setup();
      renderSearch();
      await user.type(screen.getByPlaceholderText('搜索对话...'), 'sales');
      expect(within(screen.getByRole('dialog')).getAllByRole('button').map((b) => b.textContent)).toEqual([
        'Report cleanup', 'Pricing notes',
      ]);
      // The part of the name that matched is marked.
      expect(detailOf('Pricing notes')?.querySelector('mark')).toHaveTextContent('Sales');
    });

    it('shows a content match of a project conversation with its project and the passage', async () => {
      mocks.catalogSearch.mockResolvedValue([
        hit('s', 'Report of the nightly run', 'the margin was fine'),
        hit('q', 'Pricing notes', 'the margin is 12%'),
      ]);
      const user = userEvent.setup();
      renderSearch();
      await user.type(screen.getByPlaceholderText('搜索对话...'), 'margin');
      const row = await screen.findByRole('button', { name: 'Pricing notes' });
      expect(mocks.catalogSearch).toHaveBeenLastCalledWith('margin', 500);
      expect(detailOf('Pricing notes')).toHaveTextContent('Sales 2026');
      expect(detailOf('Pricing notes')).toHaveTextContent('the margin is 12%');
      expect(screen.queryByRole('button', { name: 'Report of the nightly run' })).toBeNull();

      await user.click(row);
      expect(mocks.chat.switchConversation).toHaveBeenCalledWith('q');
      expect(mocks.chat.setPendingSearchJump).toHaveBeenCalledWith({ convId: 'q', query: 'margin' });
    });

    it('asks the sidebar to bring the opened conversation into view, with its project expanded', async () => {
      const user = userEvent.setup();
      renderSearch();
      await user.click(screen.getByRole('button', { name: 'Report cleanup' }));
      expect(useProjectStore.getState().revealConversationId).toBe('p');
      expect(useProjectStore.getState().expandedProjectIds).toEqual(['p1']);
    });
  });

  describe('more content matches than the list shows', () => {
    const index = (count: number) => Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`m${i}`, conv(`m${i}`, `Task ${i}`, count - i)]),
    );
    const hits = (count: number) => Array.from({ length: count }, (_, i) => hit(`m${i}`, `Task ${i}`, 'the budget'));

    it('lists the first fifty and says there are more', async () => {
      mocks.chat.conversationIndex = index(51);
      mocks.catalogSearch.mockResolvedValue(hits(51));
      const user = userEvent.setup();
      renderSearch();
      await user.type(screen.getByPlaceholderText('搜索对话...'), 'budget');
      expect(await screen.findByText('还有更多结果，请输入更具体的词')).toBeInTheDocument();
      expect(within(screen.getByRole('dialog')).getAllByRole('button')).toHaveLength(50);
    });

    it('says nothing when every match is listed', async () => {
      mocks.chat.conversationIndex = index(50);
      mocks.catalogSearch.mockResolvedValue(hits(50));
      const user = userEvent.setup();
      renderSearch();
      await user.type(screen.getByPlaceholderText('搜索对话...'), 'budget');
      await screen.findByRole('button', { name: 'Task 49' });
      expect(screen.queryByText('还有更多结果，请输入更具体的词')).toBeNull();
    });
  });
});
