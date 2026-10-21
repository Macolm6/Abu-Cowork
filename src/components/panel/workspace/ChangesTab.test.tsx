// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render as renderBare, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { usePreviewStore } from '@/stores/previewStore';
import { __testing as turnChangesCache } from '@/hooks/useTurnChanges';
import type { TurnChangedFile, TurnChanges } from '@/core/session/turnChanges';
import type { FileChangeHunk } from '@/types/fileChange';
import { diffTexts } from '@/core/files/fileChange';
import ChangesTab, { TurnFileComparison } from './ChangesTab';

const mocks = vi.hoisted(() => ({
  readTurnIndex: vi.fn(),
  readTurnChanges: vi.fn(),
  listeners: new Set<(conversationId: string, loopId: string) => void>(),
}));

vi.mock('@/core/session/turnChanges', () => ({
  readTurnIndex: (...args: unknown[]) => mocks.readTurnIndex(...args),
  readTurnChanges: (...args: unknown[]) => mocks.readTurnChanges(...args),
  onTurnChangesSaved: (listener: (conversationId: string, loopId: string) => void) => {
    mocks.listeners.add(listener);
    return () => { mocks.listeners.delete(listener); };
  },
}));

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const CONVERSATION_ID = 'conv-1';
const LOOP_ID = 'loop-1';

const PLAN_HUNKS: FileChangeHunk[] = [
  { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' title', '-old plan', '+new plan'] },
];
const NOTES_HUNKS: FileChangeHunk[] = [
  { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+first note'] },
];

const FILES: TurnChangedFile[] = [
  { path: '/ws/docs/notes.md', display: 'docs/notes.md', status: 'created', added: 1, deleted: 0, hunks: NOTES_HUNKS },
  { path: '/ws/plan.md', display: 'plan.md', status: 'modified', added: 1, deleted: 1, hunks: PLAN_HUNKS },
  { path: '/ws/报表.xlsx', display: '报表.xlsx', status: 'created' },
];

function turnOf(files: TurnChangedFile[]): TurnChanges {
  return {
    loopId: LOOP_ID,
    files,
    total: files.length,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
  };
}

/** Opens the tab in the store and renders its body, following the tab's file as the store moves it. */
function Harness() {
  const tab = usePreviewStore((s) => s.tabs.find((candidate) => candidate.kind === 'changes'));
  if (!tab || tab.kind !== 'changes') return null;
  return <ChangesTab tabId={tab.id} conversationId={tab.conversationId} loopId={tab.loopId} fileIndex={tab.fileIndex} />;
}

function openTab(fileIndex = 0): void {
  usePreviewStore.getState().openTurnChanges({ conversationId: CONVERSATION_ID, loopId: LOOP_ID, fileIndex, title: '改动' });
}

function setPanelWidth(width: number): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}),
  });
}

const fileList = () => within(screen.getByRole('list'));
const fileRow = (name: RegExp) => fileList().getByRole('button', { name });
const diff = () => screen.getByTestId('changes-diff');
const diffText = () => [...diff().querySelectorAll('[data-diff-row]')].map((row) => row.textContent);

describe('ChangesTab', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    turnChangesCache.reset();
    mocks.listeners.clear();
    mocks.readTurnIndex.mockReset();
    mocks.readTurnIndex.mockResolvedValue({});
    mocks.readTurnChanges.mockReset();
    mocks.readTurnChanges.mockResolvedValue(turnOf(FILES));
    usePreviewStore.setState({
      tabs: [], currentConversationId: CONVERSATION_ID, activeTabId: null,
      panelStateByConversation: {}, lastActiveTabByConversation: {},
    });
    setPanelWidth(900);
  });

  afterEach(() => {
    cleanup();
    initLanguage('en-US');
    vi.restoreAllMocks();
  });

  it('lists the files with their line counts or status and compares the file the tab was opened on', async () => {
    openTab(1);
    render(<Harness />);

    await screen.findByRole('list');
    expect(fileList().getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      'docs/notes.md+1−0', 'plan.md+1−1', '报表.xlsx新建',
    ]);
    expect(fileRow(/^plan\.md/)).toHaveAttribute('aria-current', 'true');
    expect(fileRow(/^docs\/notes\.md/)).not.toHaveAttribute('aria-current');
    expect(diff().textContent).toContain('old plan');
    expect(diff().textContent).toContain('new plan');
    expect(mocks.readTurnChanges).toHaveBeenCalledWith(CONVERSATION_ID, LOOP_ID);
  });

  it('shows every line a deleted file held before the turn, each as a deleted line', async () => {
    const compared = diffTexts('first\nsecond\nthird\n', '');
    if (!compared) throw new Error('the texts were not compared');
    mocks.readTurnChanges.mockResolvedValue(turnOf([
      { path: '/ws/old.md', display: 'old.md', status: 'deleted', added: compared.added, deleted: compared.deleted, hunks: compared.hunks },
    ]));
    openTab(0);
    render(<Harness />);
    await screen.findByRole('list');

    fireEvent.click(screen.getByRole('radio', { name: '单栏' }));
    expect(diffText()).toEqual(['1-first', '2-second', '3-third']);
  });

  it('switches the comparison to the file chosen in the list', async () => {
    openTab(1);
    render(<Harness />);
    await screen.findByRole('list');

    fireEvent.click(fileRow(/^docs\/notes\.md/));

    expect(fileRow(/^docs\/notes\.md/)).toHaveAttribute('aria-current', 'true');
    expect(diff().textContent).toContain('first note');
    expect(diff().textContent).not.toContain('new plan');
    expect(usePreviewStore.getState().tabs[0]).toMatchObject({ kind: 'changes', fileIndex: 0 });
  });

  it('compares side by side by default, and before above after once the reader chooses so', async () => {
    openTab(1);
    render(<Harness />);
    await screen.findByRole('list');

    expect(diff()).toHaveAttribute('data-diff-layout', 'split');
    expect(screen.getByRole('radio', { name: '左右对照' })).toHaveAttribute('data-state', 'on');
    expect(diff().querySelectorAll('[data-diff-pair]')).toHaveLength(2);

    fireEvent.click(screen.getByRole('radio', { name: '单栏' }));
    expect(diff()).toHaveAttribute('data-diff-layout', 'unified');
    expect(diff().querySelectorAll('[data-diff-pair]')).toHaveLength(0);
    expect(diffText()).toEqual(['11title', '2-old plan', '2+new plan']);

    fireEvent.click(screen.getByRole('radio', { name: '左右对照' }));
    expect(diff()).toHaveAttribute('data-diff-layout', 'split');
  });

  it('compares before above after in a panel narrower than 640 pixels, until the reader chooses side by side', async () => {
    setPanelWidth(520);
    openTab(1);
    render(<Harness />);
    await screen.findByRole('list');

    expect(diff()).toHaveAttribute('data-diff-layout', 'unified');
    expect(screen.getByRole('radio', { name: '单栏' })).toHaveAttribute('data-state', 'on');

    fireEvent.click(screen.getByRole('radio', { name: '左右对照' }));
    expect(diff()).toHaveAttribute('data-diff-layout', 'split');
  });

  it('opens the file in view in the side preview', async () => {
    openTab(1);
    render(<Harness />);
    await screen.findByRole('list');

    fireEvent.click(screen.getByRole('button', { name: '打开文件' }));

    const tabs = usePreviewStore.getState().tabs;
    expect(tabs.map((tab) => tab.kind)).toEqual(['changes', 'preview']);
    expect(tabs[1]).toMatchObject({ kind: 'preview', filePath: '/ws/plan.md' });
  });

  it('says there is no comparison for a file without hunks, and still opens it', async () => {
    openTab(2);
    render(<Harness />);
    await screen.findByRole('list');

    expect(screen.getByText('这份文件没有可以显示的对比')).toBeInTheDocument();
    expect(screen.queryByTestId('changes-diff')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '打开文件' }));
    expect(usePreviewStore.getState().tabs[1]).toMatchObject({ kind: 'preview', filePath: '/ws/报表.xlsx' });
  });

  it('shows the first file for a file index the turn does not have', async () => {
    openTab(9);
    render(<Harness />);
    await screen.findByRole('list');
    expect(fileRow(/^docs\/notes\.md/)).toHaveAttribute('aria-current', 'true');
    expect(diff().textContent).toContain('first note');
  });

  it('says the changes cannot be read, and reads them again on retry', async () => {
    mocks.readTurnChanges.mockRejectedValueOnce(new Error('EIO'));
    openTab(1);
    render(<Harness />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('无法读取改动');
    expect(screen.queryByRole('list')).toBeNull();

    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));

    await screen.findByRole('list');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mocks.readTurnChanges).toHaveBeenCalledTimes(2);
  });

  it('keeps the explanation with a busy retry button while the retry reads, then hands the focus to the row of the file in view', async () => {
    mocks.readTurnChanges.mockRejectedValueOnce(new Error('EIO'));
    openTab(1);
    render(<Harness />);
    const retry = within(await screen.findByRole('alert')).getByRole('button', { name: '重试' });
    let release: (turn: TurnChanges) => void = () => {};
    mocks.readTurnChanges.mockReturnValueOnce(new Promise<TurnChanges>((resolve) => { release = resolve; }));

    retry.focus();
    fireEvent.click(retry);

    expect(screen.getByRole('alert')).toHaveTextContent('无法读取改动');
    expect(screen.getByRole('button', { name: '重试' })).toHaveAttribute('aria-disabled', 'true');

    await act(async () => { release(turnOf(FILES)); });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(fileRow(/^plan\.md/)).toHaveFocus();
  });

  it('gives the file list one tab stop, on the file in view, and walks it with the arrow keys without changing the file', async () => {
    openTab(1);
    render(<Harness />);
    await screen.findByRole('list');
    const notes = fileRow(/^docs\/notes\.md/);
    const plan = fileRow(/^plan\.md/);
    const sheet = fileRow(/^报表\.xlsx/);

    expect([notes.tabIndex, plan.tabIndex, sheet.tabIndex]).toEqual([-1, 0, -1]);

    plan.focus();
    fireEvent.keyDown(plan, { key: 'ArrowDown' });
    expect(sheet).toHaveFocus();
    fireEvent.keyDown(sheet, { key: 'ArrowDown' });
    expect(sheet).toHaveFocus();
    fireEvent.keyDown(sheet, { key: 'Home' });
    expect(notes).toHaveFocus();
    fireEvent.keyDown(notes, { key: 'ArrowUp' });
    expect(notes).toHaveFocus();
    fireEvent.keyDown(notes, { key: 'End' });
    expect(sheet).toHaveFocus();
    fireEvent.keyDown(sheet, { key: 'ArrowUp' });
    expect(plan).toHaveFocus();

    expect(plan).toHaveAttribute('aria-current', 'true');
    expect(usePreviewStore.getState().tabs[0]).toMatchObject({ fileIndex: 1 });
  });

  it('asks for the focus on the preview tab it opens, since its own panel leaves the page', async () => {
    openTab(1);
    render(<Harness />);
    await screen.findByRole('list');

    fireEvent.click(screen.getByRole('button', { name: '打开文件' }));

    const state = usePreviewStore.getState();
    const preview = state.tabs.find((tab) => tab.kind === 'preview');
    expect(state.activeTabId).toBe(preview?.id);
    expect(state.focusTabId).toBe(preview?.id);
  });

  it('says the changes cannot be read when the turn has no saved changes', async () => {
    mocks.readTurnChanges.mockResolvedValue(null);
    openTab(0);
    render(<Harness />);
    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取改动');
  });

  it('shows nothing of the turn while it is being read', async () => {
    let release: (turn: TurnChanges) => void = () => {};
    mocks.readTurnChanges.mockReturnValue(new Promise<TurnChanges>((resolve) => { release = resolve; }));
    openTab(0);
    render(<Harness />);
    await waitFor(() => expect(mocks.readTurnChanges).toHaveBeenCalled());
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => { release(turnOf(FILES)); });
    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  describe('a turn that is undone', () => {
    const ENTRY = { total: 3, added: 2, deleted: 1, firstFile: 'notes.md', restorable: 2 };
    const saved = (): void => {
      for (const listener of [...mocks.listeners]) listener(CONVERSATION_ID, LOOP_ID);
    };

    it('says on top that the changes of the turn are undone, above the comparison of that time', async () => {
      mocks.readTurnIndex.mockResolvedValue({ [LOOP_ID]: { ...ENTRY, undone: true } });
      openTab(1);
      render(<Harness />);

      const line = await screen.findByText('这一轮的改动已经撤销');
      expect(line.compareDocumentPosition(screen.getByRole('list')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(diff().textContent).toContain('old plan');
      expect(diff().textContent).toContain('new plan');
    });

    it('says nothing of the kind for a turn that is not undone', async () => {
      mocks.readTurnIndex.mockResolvedValue({ [LOOP_ID]: ENTRY });
      openTab(1);
      render(<Harness />);
      await screen.findByRole('list');
      await act(async () => {});
      expect(screen.queryByText('这一轮的改动已经撤销')).toBeNull();
    });

    it('takes the line away once the changes are put back', async () => {
      mocks.readTurnIndex.mockResolvedValue({ [LOOP_ID]: { ...ENTRY, undone: true } });
      openTab(1);
      render(<Harness />);
      await screen.findByText('这一轮的改动已经撤销');

      mocks.readTurnIndex.mockResolvedValue({ [LOOP_ID]: ENTRY });
      act(() => saved());

      await waitFor(() => expect(screen.queryByText('这一轮的改动已经撤销')).toBeNull());
      expect(diff().textContent).toContain('new plan');
    });
  });
});

describe('TurnFileComparison', () => {
  function created(lineCount: number): TurnChangedFile {
    const lines = Array.from({ length: lineCount }, (_, index) => `+line ${index + 1}`);
    return {
      path: '/ws/long.md', display: 'long.md', status: 'created', added: lineCount, deleted: 0,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: lineCount, lines }],
    };
  }

  beforeEach(() => {
    initLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
    initLanguage('en-US');
  });

  it.each(['unified', 'split'] as const)('renders the lines up to its limit in the %s layout and says the comparison is cut', (layout) => {
    render(<TurnFileComparison file={created(8)} layout={layout} maxLines={5} />);

    expect(diff().querySelectorAll('[data-diff-row="added"]')).toHaveLength(5);
    expect(diff().textContent).toContain('line 5');
    expect(diff().textContent).not.toContain('line 6');
    expect(screen.getByText('对比过长，只显示前面的部分')).toBeInTheDocument();
  });

  it('does not say a comparison that is exactly at the limit is cut', () => {
    render(<TurnFileComparison file={created(5)} layout="unified" maxLines={5} />);

    expect(diff().querySelectorAll('[data-diff-row="added"]')).toHaveLength(5);
    expect(screen.queryByText('对比过长，只显示前面的部分')).toBeNull();
  });
});
