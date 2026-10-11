// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render as renderBare, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { usePreviewStore } from '@/stores/previewStore';
import { __testing as turnChangesCache } from '@/hooks/useTurnChanges';
import type { TurnChangedFile, TurnChanges, TurnIndex } from '@/core/session/turnChanges';
import ChangedFilesCard from './ChangedFilesCard';

const mocks = vi.hoisted(() => ({
  readTurnIndex: vi.fn(),
  readTurnChanges: vi.fn(),
}));

vi.mock('@/core/session/turnChanges', () => ({
  readTurnIndex: (...args: unknown[]) => mocks.readTurnIndex(...args),
  readTurnChanges: (...args: unknown[]) => mocks.readTurnChanges(...args),
  onTurnChangesSaved: () => () => {},
}));

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const CONVERSATION_ID = 'conv-1';
const LOOP_ID = 'loop-1';

function counted(display: string, added: number, deleted: number, status: TurnChangedFile['status'] = 'modified'): TurnChangedFile {
  return { path: `/ws/${display}`, display, status, added, deleted, hunks: [] };
}

function uncounted(display: string, status: TurnChangedFile['status']): TurnChangedFile {
  return { path: `/ws/${display}`, display, status };
}

/** Saves one turn the way endTurn would: its file and its index entry. */
function saveTurn(files: TurnChangedFile[], extra: { total?: number; moreFiles?: number } = {}): TurnChanges {
  const total = extra.total ?? files.length;
  const turn: TurnChanges = {
    loopId: LOOP_ID,
    files,
    ...(extra.moreFiles ? { moreFiles: extra.moreFiles } : {}),
    total,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
  };
  const firstFile = files[0].display.slice(files[0].display.lastIndexOf('/') + 1);
  mocks.readTurnIndex.mockResolvedValue({
    [LOOP_ID]: { total, added: turn.added, deleted: turn.deleted, firstFile },
  } satisfies TurnIndex);
  mocks.readTurnChanges.mockResolvedValue(turn);
  return turn;
}

const card = () => screen.queryByTestId('changed-files-card');
const rows = () => within(screen.getByTestId('changed-files-card')).queryAllByRole('listitem');

describe('ChangedFilesCard', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    turnChangesCache.reset();
    mocks.readTurnIndex.mockReset();
    mocks.readTurnChanges.mockReset();
    mocks.readTurnIndex.mockResolvedValue({});
    mocks.readTurnChanges.mockResolvedValue(null);
    usePreviewStore.setState({
      tabs: [], currentConversationId: CONVERSATION_ID, activeTabId: null,
      panelStateByConversation: {}, lastActiveTabByConversation: {},
    });
  });

  afterEach(() => {
    cleanup();
    initLanguage('en-US');
    vi.restoreAllMocks();
  });

  it('titles a turn with several files by their count, with the total line counts, one row per file', async () => {
    saveTurn([counted('a.md', 3, 1), counted('docs/b.md', 2, 0), counted('new.md', 4, 0, 'created')]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    const title = await screen.findByRole('button', { name: /^已编辑 3 个文件/ });
    expect(title).toHaveTextContent('+9');
    expect(title).toHaveTextContent('−1');
    expect(rows().map((row) => row.textContent)).toEqual(['a.md+3−1', 'docs/b.md+2−0', 'new.md+4−0']);
  });

  it('shows only the title, with the file name, for a turn that changed one file', async () => {
    saveTurn([counted('docs/方案.md', 3, 3)]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    const title = await screen.findByRole('button', { name: /^已编辑 方案\.md/ });
    expect(title).toHaveTextContent('+3');
    expect(title).toHaveTextContent('−3');
    expect(rows()).toHaveLength(0);
    expect(mocks.readTurnChanges).not.toHaveBeenCalled();
  });

  it('shows the three status words for files without line counts, and no total when no file has counts', async () => {
    saveTurn([uncounted('合同.docx', 'modified'), uncounted('报表.xlsx', 'created'), uncounted('旧稿.md', 'deleted')]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    const title = await screen.findByRole('button', { name: '已编辑 3 个文件' });
    expect(title).not.toHaveTextContent('+');
    expect(rows().map((row) => row.textContent)).toEqual(['合同.docx已修改', '报表.xlsx新建', '旧稿.md已删除']);
  });

  it('shows a file deleted with the file tool as +0 and its deleted lines', async () => {
    saveTurn([counted('草稿.md', 0, 12, 'deleted'), counted('a.md', 1, 0)]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    await screen.findByRole('button', { name: /^已编辑 2 个文件/ });
    expect(rows()[0].textContent).toBe('草稿.md+0−12');
  });

  it('shows four of six files, then all six, then four again', async () => {
    saveTurn(Array.from({ length: 6 }, (_, index) => counted(`file-${index + 1}.md`, 1, 0)));
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    const expand = await screen.findByRole('button', { name: '全部 6 个文件' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(rows()).toHaveLength(4);

    fireEvent.click(expand);
    expect(rows()).toHaveLength(6);
    const collapse = screen.getByRole('button', { name: '收起' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(collapse);
    expect(rows()).toHaveLength(4);
    expect(screen.getByRole('button', { name: '全部 6 个文件' })).toBeInTheDocument();
  });

  it('shows no expand button for exactly four files', async () => {
    saveTurn(Array.from({ length: 4 }, (_, index) => counted(`file-${index + 1}.md`, 1, 0)));
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    await screen.findByRole('button', { name: /^已编辑 4 个文件/ });
    expect(rows()).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /全部/ })).toBeNull();
  });

  it('counts every changed file in the title and the button, and says how many it leaves out once all are shown', async () => {
    saveTurn(
      Array.from({ length: 5 }, (_, index) => counted(`file-${index + 1}.md`, 1, 0)),
      { total: 7, moreFiles: 2 },
    );
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    await screen.findByRole('button', { name: /^已编辑 7 个文件/ });
    expect(screen.queryByText('另有 2 个文件')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '全部 7 个文件' }));
    expect(rows()).toHaveLength(5);
    expect(screen.getByText('另有 2 个文件')).toBeInTheDocument();
  });

  it('renders nothing for a turn that changed no file', async () => {
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);
    await waitFor(() => expect(mocks.readTurnIndex).toHaveBeenCalled());
    await act(async () => {});
    expect(card()).toBeNull();
  });

  it('renders nothing while the index or the files of the turn are being read', async () => {
    let releaseTurn: (turn: TurnChanges) => void = () => {};
    const turn = saveTurn([counted('a.md', 1, 0), counted('b.md', 1, 0)]);
    mocks.readTurnChanges.mockReturnValue(new Promise<TurnChanges>((resolve) => { releaseTurn = resolve; }));

    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);
    expect(card()).toBeNull();
    await waitFor(() => expect(mocks.readTurnChanges).toHaveBeenCalled());
    expect(card()).toBeNull();

    await act(async () => { releaseTurn(turn); });
    expect(card()).not.toBeNull();
  });

  it('shows the title alone when the files of the turn cannot be read', async () => {
    saveTurn([counted('a.md', 1, 0), counted('b.md', 1, 0)]);
    mocks.readTurnChanges.mockRejectedValue(new Error('EIO'));
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    await screen.findByRole('button', { name: /^已编辑 2 个文件/ });
    expect(rows()).toHaveLength(0);
  });

  it('opens the changes tab on the first file from the title, named after the first file and the count', async () => {
    saveTurn([counted('a.md', 1, 0), counted('docs/b.md', 1, 0), counted('c.md', 1, 0)]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    fireEvent.click(await screen.findByRole('button', { name: /^已编辑 3 个文件/ }));

    expect(usePreviewStore.getState().tabs).toMatchObject([{
      kind: 'changes', conversationId: CONVERSATION_ID, loopId: LOOP_ID, fileIndex: 0, title: '改动：a.md 等 3 个文件',
    }]);
  });

  it('opens the changes tab on the file of the row that was pressed, and returns to the same tab', async () => {
    saveTurn([counted('a.md', 1, 0), counted('docs/b.md', 1, 0), counted('c.md', 1, 0)]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    fireEvent.click(await screen.findByRole('button', { name: /^docs\/b\.md/ }));
    fireEvent.click(screen.getByRole('button', { name: /^c\.md/ }));

    const tabs = usePreviewStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: 'changes', fileIndex: 2 });
  });

  it('names the tab after the one file of a single-file turn', async () => {
    saveTurn([counted('docs/方案.md', 3, 3)]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    fireEvent.click(await screen.findByRole('button', { name: /^已编辑 方案\.md/ }));

    expect(usePreviewStore.getState().tabs).toMatchObject([{ kind: 'changes', fileIndex: 0, title: '改动：方案.md' }]);
  });

  it('mounts no tooltip and no menu', async () => {
    saveTurn([counted('a.md', 1, 0), counted('b.md', 1, 0)]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);
    const root = await screen.findByTestId('changed-files-card');
    expect(root.querySelector('[data-state]')).toBeNull();
    expect(root.querySelector('[aria-haspopup]')).toBeNull();
  });
});
