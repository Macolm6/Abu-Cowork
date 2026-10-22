// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { DesignSystemProvider } from '@/components/ds/provider';
import type { TurnIndex, TurnIndexEntry, TurnIndexFile } from '@/core/session/turnChanges';
import { resolveFileSource } from '@/core/session/outputSnapshots';
import { __testing as turnChangesHooks } from '@/hooks/useTurnChanges';
import { setLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import type { Conversation, Message } from '@/types';
import ChangedFilesSection from './ChangedFilesSection';

const mocks = vi.hoisted(() => ({
  readTurnIndex: vi.fn(),
  listVersions: vi.fn(),
}));

vi.mock('@/core/session/turnChanges', () => ({
  readTurnIndex: (...args: unknown[]) => mocks.readTurnIndex(...args),
  readTurnChanges: vi.fn(),
  readTurnUndoRecord: vi.fn(),
  onTurnChangesSaved: () => () => {},
}));

vi.mock('@/utils/canvasVersions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/canvasVersions')>()),
  listVersions: (...args: unknown[]) => mocks.listVersions(...args),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/core/session/outputSnapshots', () => ({
  resolveFileSource: vi.fn(),
}));

const CONV = 'conv-1';
const WS = '/work';

function file(display: string, status: TurnIndexFile['status']): TurnIndexFile {
  return { path: `${WS}/${display}`, display, status };
}

function entry(files: TurnIndexFile[]): TurnIndexEntry {
  return { total: files.length, added: 0, deleted: 0, firstFile: files[0].display, files };
}

/** One user message and one reply per turn, in order. */
function seed(turns: Array<{ loopId: string; prompt: string; at: number }>) {
  const messages: Message[] = turns.flatMap(({ loopId, prompt, at }): Message[] => [
    { id: `u-${loopId}`, role: 'user', content: prompt, timestamp: at },
    { id: `a-${loopId}`, role: 'assistant', content: 'done', timestamp: at + 1, loopId },
  ]);
  const conversation: Conversation = { id: CONV, title: 'c', messages, createdAt: 1, updatedAt: 1, status: 'idle', workspacePath: WS };
  useChatStore.setState({ activeConversationId: CONV, conversations: { [CONV]: conversation } });
}

function renderSection() {
  return render(<DesignSystemProvider><ChangedFilesSection /></DesignSystemProvider>);
}

const rows = () => screen.queryAllByTestId('changed-file-row');
const rowOf = (name: string) => rows().find((row) => within(row).queryByText(name)) as HTMLElement;

async function openRowMenu(name: string) {
  const user = userEvent.setup();
  await user.click(within(rowOf(name)).getByRole('button', { name: '更多操作' }));
  return { user, menu: await screen.findByRole('menu') };
}

describe('ChangedFilesSection', () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });

  beforeEach(() => {
    setLanguage('zh-CN');
    turnChangesHooks.reset();
    mocks.readTurnIndex.mockReset();
    mocks.listVersions.mockReset();
    mocks.listVersions.mockResolvedValue([]);
    vi.mocked(resolveFileSource).mockReset();
    vi.mocked(resolveFileSource).mockImplementation(async (_conversationId, path) => ({ status: 'available', path, isFromSnapshot: false }));
    vi.mocked(revealItemInDir).mockClear();
    usePreviewStore.setState({ tabs: [], activeTabId: null });
  });

  afterEach(() => {
    cleanup();
    setLanguage('system');
    vi.restoreAllMocks();
  });

  it('lists each changed file once with its mark, the latest changed first, under its title and count', async () => {
    seed([{ loopId: 'loop-1', prompt: '写方案', at: 1_000 }, { loopId: 'loop-2', prompt: '改方案', at: 2_000 }]);
    mocks.readTurnIndex.mockResolvedValue({
      'loop-1': entry([file('plan.md', 'created'), file('old.md', 'deleted')]),
      'loop-2': entry([file('data.csv', 'modified'), file('plan.md', 'modified')]),
    } satisfies TurnIndex);
    renderSection();

    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.getByRole('region', { name: '改过的文件' })).toHaveTextContent('3 个');
    expect(rows().map((row) => row.textContent)).toEqual(['data.csv修改', 'plan.md新建', 'old.md删除']);
    expect(within(rowOf('plan.md')).getByText('plan.md').closest('button')).toHaveAttribute('title', `${WS}/plan.md`);
  });

  it('says where the changed files will be listed when nothing changed yet', async () => {
    seed([{ loopId: 'loop-1', prompt: '看看', at: 1_000 }]);
    mocks.readTurnIndex.mockResolvedValue({} satisfies TurnIndex);
    renderSection();

    expect(await screen.findByText('阿布改过的文件会列在这里')).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
  });

  it('shows seven files, then every file once asked, and folds them again', async () => {
    const user = userEvent.setup();
    seed([{ loopId: 'loop-1', prompt: '批量', at: 1_000 }]);
    const many = Array.from({ length: 9 }, (_, index) => file(`f${index}.md`, 'created'));
    mocks.readTurnIndex.mockResolvedValue({ 'loop-1': entry(many) } satisfies TurnIndex);
    renderSection();

    await waitFor(() => expect(rows()).toHaveLength(7));
    await user.click(screen.getByRole('button', { name: '还有 2 个文件' }));
    expect(rows()).toHaveLength(9);
    await user.click(screen.getByRole('button', { name: '收起' }));
    expect(rows()).toHaveLength(7);
  });

  describe('opening a file', () => {
    beforeEach(() => {
      seed([{ loopId: 'loop-1', prompt: '写', at: 1_000 }]);
      mocks.readTurnIndex.mockResolvedValue({
        'loop-1': entry([file('here.md', 'modified'), file('kept.md', 'deleted'), file('gone.md', 'deleted')]),
      } satisfies TurnIndex);
      vi.mocked(resolveFileSource).mockImplementation(async (_conversationId, path) => {
        if (path.endsWith('here.md')) return { status: 'available', path, isFromSnapshot: false };
        if (path.endsWith('kept.md')) return { status: 'available', path: '/data/copy/kept.md', isFromSnapshot: true };
        return { status: 'missing', basename: 'gone.md', originalPath: path };
      });
    });

    it('opens a file in place, the copy Abu kept of one that is gone, and nothing for one with neither', async () => {
      const openPreview = vi.spyOn(usePreviewStore.getState(), 'openPreview').mockImplementation(() => {});
      usePreviewStore.setState({ openPreview });
      renderSection();
      await waitFor(() => expect(rows()).toHaveLength(3));
      await waitFor(() => expect(within(rowOf('gone.md')).getByText('gone.md').closest('button')).toHaveAttribute('title', '文件已经不在了'));

      fireEvent.click(within(rowOf('here.md')).getByText('here.md'));
      fireEvent.click(within(rowOf('kept.md')).getByText('kept.md'));
      fireEvent.click(within(rowOf('gone.md')).getByText('gone.md'));

      expect(openPreview.mock.calls).toEqual([[`${WS}/here.md`], ['/data/copy/kept.md', { keptCopyOf: `${WS}/kept.md` }]]);
    });

    it('offers the file manager and the versions only for a file in place', async () => {
      renderSection();
      await waitFor(() => expect(rows()).toHaveLength(3));

      const { user, menu } = await openRowMenu('here.md');
      expect(within(menu).getByRole('menuitem', { name: '在文件管理器中显示' })).toBeInTheDocument();
      expect(within(menu).getByRole('menuitem', { name: '历史版本' })).toBeInTheDocument();
      await user.click(within(menu).getByRole('menuitem', { name: '在文件管理器中显示' }));
      expect(revealItemInDir).toHaveBeenCalledWith(`${WS}/here.md`);
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

      const kept = await openRowMenu('kept.md');
      expect(within(kept.menu).queryByRole('menuitem', { name: '在文件管理器中显示' })).toBeNull();
      expect(within(kept.menu).queryByRole('menuitem', { name: '历史版本' })).toBeNull();
      expect(within(kept.menu).getByRole('menuitem', { name: '查看改动' })).toBeInTheDocument();
    });
  });

  it('offers no versions for a type that has none', async () => {
    seed([{ loopId: 'loop-1', prompt: '画图', at: 1_000 }]);
    mocks.readTurnIndex.mockResolvedValue({ 'loop-1': entry([file('chart.png', 'created')]) } satisfies TurnIndex);
    renderSection();
    await waitFor(() => expect(rows()).toHaveLength(1));

    const { menu } = await openRowMenu('chart.png');
    expect(within(menu).queryByRole('menuitem', { name: '历史版本' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: '在文件管理器中显示' })).toBeInTheDocument();
  });

  it('opens the changes of the one turn that changed a file, on that file', async () => {
    seed([{ loopId: 'loop-1', prompt: '写', at: 1_000 }]);
    mocks.readTurnIndex.mockResolvedValue({ 'loop-1': entry([file('a.md', 'created'), file('b.md', 'created')]) } satisfies TurnIndex);
    const openTurnChanges = vi.fn(() => 'tab');
    usePreviewStore.setState({ openTurnChanges });
    renderSection();
    await waitFor(() => expect(rows()).toHaveLength(2));

    const { user, menu } = await openRowMenu('b.md');
    await user.click(within(menu).getByRole('menuitem', { name: '查看改动' }));

    expect(openTurnChanges).toHaveBeenCalledExactlyOnceWith({ conversationId: CONV, loopId: 'loop-1', fileIndex: 1, title: '改动：a.md 等 2 个文件' });
  });

  it('lets the user choose the turn whose changes to open, the latest first', async () => {
    seed([{ loopId: 'loop-2', prompt: '第一次修改', at: 2_000 }, { loopId: 'loop-5', prompt: '第二次修改', at: 5_000 }]);
    mocks.readTurnIndex.mockResolvedValue({
      'loop-2': entry([file('a.md', 'modified')]),
      'loop-5': entry([file('a.md', 'modified')]),
    } satisfies TurnIndex);
    const openTurnChanges = vi.fn(() => 'tab');
    usePreviewStore.setState({ openTurnChanges });
    renderSection();
    await waitFor(() => expect(rows()).toHaveLength(1));

    const { user, menu } = await openRowMenu('a.md');
    within(menu).getByRole('menuitem', { name: '查看改动' }).focus();
    await user.keyboard('{ArrowRight}');
    const menus = await screen.findAllByRole('menu');
    const turns = within(menus[menus.length - 1]).getAllByRole('menuitem');
    expect(turns.map((item) => item.textContent?.split(/\d/)[0])).toEqual(['第二次修改', '第一次修改']);

    await user.click(turns[1]);
    expect(openTurnChanges).toHaveBeenCalledExactlyOnceWith({ conversationId: CONV, loopId: 'loop-2', fileIndex: 0, title: '改动：a.md' });
  });

  it('opens the same menu on a right-click of the row', async () => {
    seed([{ loopId: 'loop-1', prompt: '写', at: 1_000 }]);
    mocks.readTurnIndex.mockResolvedValue({ 'loop-1': entry([file('a.md', 'created')]) } satisfies TurnIndex);
    renderSection();
    await waitFor(() => expect(rows()).toHaveLength(1));

    fireEvent.contextMenu(rowOf('a.md'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['查看改动', '历史版本', '在文件管理器中显示']);
  });

  it('asks before restoring a version chosen from the row, once the menu has gone, listing this conversation only', async () => {
    seed([{ loopId: 'loop-1', prompt: '写', at: 1_000 }]);
    mocks.readTurnIndex.mockResolvedValue({ 'loop-1': entry([file('a.md', 'modified')]) } satisfies TurnIndex);
    mocks.listVersions.mockResolvedValue([{ id: '2-1', ts: 2, byteSize: 3, source: 'ai', label: '写', origins: [{ conversationId: CONV }] }]);
    renderSection();
    await waitFor(() => expect(rows()).toHaveLength(1));

    const { user, menu } = await openRowMenu('a.md');
    within(menu).getByRole('menuitem', { name: '历史版本' }).focus();
    await user.keyboard('{ArrowRight}');
    const versions = await screen.findAllByRole('menuitem', { name: /\d{2}:\d{2}:\d{2}/ });
    await user.click(versions[0]);

    expect(await screen.findByRole('alertdialog')).toHaveAccessibleName(/^把 a\.md 恢复到 .+ 的样子？$/);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(mocks.listVersions).toHaveBeenCalledWith(`${WS}/a.md`, { conversationId: CONV });
  });
});
