// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { setLanguage } from '@/i18n';
import { usePreviewStore } from '@/stores/previewStore';
import { useToastStore } from '@/stores/toastStore';
import { passSettleInterval } from '@/test/dsWindows';
import { REVERT_LABEL } from '@/utils/canvasVersions';

const listVersionsMock = vi.fn();
const revertToVersionMock = vi.fn();
vi.mock('@/utils/canvasVersions', async () => {
  const actual = await vi.importActual<typeof import('@/utils/canvasVersions')>('@/utils/canvasVersions');
  return {
    ...actual,
    listVersions: (...args: unknown[]) => listVersionsMock(...args),
    revertToVersion: (...args: unknown[]) => revertToVersionMock(...args),
  };
});

import { VersionHistoryMenu } from './VersionHistoryMenu';
import { formatVersionTime } from './versionTime';

const TIME = /\d{2}:\d{2}:\d{2}/;

function Harness({ initialOpen }: { initialOpen: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <VersionHistoryMenu
      filePath="/w/a.html"
      open={open}
      onOpenChange={setOpen}
      trigger={<Button>History</Button>}
    />
  );
}

const toastTitles = () => useToastStore.getState().toasts.map((toast) => [toast.type, toast.title, toast.message]);

describe('VersionHistoryMenu', () => {
  // happy-dom lacks the pointer-capture and scroll methods Radix menus call.
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });

  beforeEach(() => {
    vi.clearAllMocks();
    revertToVersionMock.mockResolvedValue('restored');
    setLanguage('zh-CN');
    useToastStore.setState({ toasts: [] });
    usePreviewStore.setState({ currentConversationId: 'conv-1' });
  });

  afterEach(() => {
    cleanup();
    setLanguage('system');
    usePreviewStore.setState({ currentConversationId: null });
  });

  function renderMenu({ initialOpen = true }: { initialOpen?: boolean } = {}) {
    return render(
      <DesignSystemProvider>
        <Harness initialOpen={initialOpen} />
      </DesignSystemProvider>,
    );
  }

  async function pickFirstVersion() {
    const user = userEvent.setup();
    renderMenu({ initialOpen: false });
    await user.click(screen.getByRole('button', { name: 'History' }));
    await user.click((await screen.findAllByRole('menuitem'))[0]);
    const question = await screen.findByRole('alertdialog');
    passSettleInterval();
    return { user, question };
  }

  it('lists every version of the file', async () => {
    listVersionsMock.mockResolvedValue([{ id: '1-0', ts: 1, byteSize: 10 }]);
    renderMenu();
    await screen.findAllByRole('menuitem');
    expect(listVersionsMock).toHaveBeenCalledWith('/w/a.html', undefined);
  });

  it('marks a version Abu left before its edit with the user message, and a version kept before a restore', async () => {
    listVersionsMock.mockResolvedValue([
      { id: '3-2', ts: 3, byteSize: 10, source: 'manual', label: REVERT_LABEL },
      { id: '2-1', ts: 2, byteSize: 10, source: 'ai', label: '把标题改成蓝色' },
      { id: '1-0', ts: 1, byteSize: 10 },
    ]);
    renderMenu();

    const items = await screen.findAllByRole('menuitem');
    expect(within(items[0]).getByText('恢复前另存')).toBeInTheDocument();
    // A row without a user message is described by its hint alone.
    expect(items[0]).toHaveAccessibleDescription('恢复到此版本');
    expect(within(items[1]).getByText('阿布修改前')).toBeInTheDocument();
    expect(items[1]).toHaveAccessibleDescription('把标题改成蓝色');
    expect(items[2]).toHaveAccessibleDescription('恢复到此版本');
    expect(within(items[2]).queryByText(/阿布修改前|恢复前另存/)).toBeNull();
    expect(screen.queryByText(REVERT_LABEL)).toBeNull();
  });

  it('shows one menu item per version: the time as its name, no size, and a hint of what choosing it does', async () => {
    listVersionsMock.mockResolvedValue([
      { id: '2-1', ts: 2, byteSize: 2048, source: 'ai', label: '把标题改成蓝色' },
      { id: '1-0', ts: 1, byteSize: 10 },
    ]);
    renderMenu();

    const items = await screen.findAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAccessibleName(TIME);
    expect(items[1]).toHaveAccessibleName(TIME);
    expect(screen.getByRole('menu')).toHaveTextContent('历史版本');
    expect(screen.getByRole('menu')).not.toHaveTextContent(/KB|\d B/);
    expect(screen.getByText('把标题改成蓝色')).toHaveClass('truncate');
    for (const item of items) expect(item).toHaveAttribute('title', '恢复到此版本');
    // Rows with and without a tag have the same first-line height (the tag's).
    expect(screen.getByText('阿布修改前').parentElement).toHaveClass('h-5');
    expect(within(items[1]).getByText(TIME).parentElement).toHaveClass('h-5');
    const list = items[0].parentElement;
    expect(list).toHaveClass('max-h-80');
    expect(list).toHaveClass('overflow-y-auto');
  });

  it('asks before restoring, once the menu has gone, and restores nothing on cancel', async () => {
    listVersionsMock.mockResolvedValue([{ id: '2-1', ts: 2, byteSize: 10 }]);
    const { user, question } = await pickFirstVersion();

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(question).toHaveAccessibleName(`把 a.html 恢复到 ${formatVersionTime(2)} 的样子？`);
    expect(question).toHaveTextContent('现在的内容会另存一份，可以在历史版本里找回。');
    expect(within(question).getByRole('button', { name: '恢复' })).toBeInTheDocument();

    await user.click(within(question).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(revertToVersionMock).not.toHaveBeenCalled();
    expect(toastTitles()).toEqual([]);
  });

  it('restores the chosen version for the conversation of the panel and says so', async () => {
    listVersionsMock.mockResolvedValue([{ id: '2-1', ts: 2, byteSize: 10 }, { id: '1-0', ts: 1, byteSize: 10 }]);
    const { user, question } = await pickFirstVersion();

    await user.click(within(question).getByRole('button', { name: '恢复' }));

    await waitFor(() => expect(toastTitles()).toEqual([['success', '已恢复到该版本', undefined]]));
    expect(revertToVersionMock).toHaveBeenCalledExactlyOnceWith('/w/a.html', '2-1', { conversationId: 'conv-1' });
  });

  it('says that the restore failed, and why', async () => {
    revertToVersionMock.mockRejectedValue(new Error('磁盘已满'));
    listVersionsMock.mockResolvedValue([{ id: '2-1', ts: 2, byteSize: 10 }]);
    const { user, question } = await pickFirstVersion();

    await user.click(within(question).getByRole('button', { name: '恢复' }));

    await waitFor(() => expect(toastTitles()).toEqual([['error', '恢复失败', '磁盘已满']]));
  });

  it('chooses nothing with the arrow keys, and closes on Escape with focus back on its button', async () => {
    const user = userEvent.setup();
    listVersionsMock.mockResolvedValue([{ id: '2-1', ts: 2, byteSize: 10 }, { id: '1-0', ts: 1, byteSize: 10 }]);
    renderMenu({ initialOpen: false });

    const trigger = screen.getByRole('button', { name: 'History' });
    await user.click(trigger);
    await screen.findAllByRole('menuitem');
    await user.keyboard('{ArrowDown}{ArrowDown}{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('shows one spinner with its sentence while the list is being read', async () => {
    listVersionsMock.mockReturnValue(new Promise(() => {}));
    renderMenu();

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('加载中...');
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('says so when the file has no versions', async () => {
    listVersionsMock.mockResolvedValue([]);
    renderMenu();

    await waitFor(() => expect(screen.getByText('暂无历史版本')).toBeInTheDocument());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says so when the list cannot be read, and reads it again when the menu opens again', async () => {
    const user = userEvent.setup();
    listVersionsMock.mockRejectedValueOnce(new Error('EIO')).mockResolvedValue([{ id: '1-0', ts: 1, byteSize: 10 }]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderMenu({ initialOpen: false });

    const trigger = screen.getByRole('button', { name: 'History' });
    await user.click(trigger);
    expect(await screen.findByText('加载历史版本失败')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    await user.click(trigger);
    expect(await screen.findAllByRole('menuitem')).toHaveLength(1);
    expect(listVersionsMock).toHaveBeenCalledTimes(2);
  });
});
