// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readDir } from '@tauri-apps/plugin-fs';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { passSettleInterval } from '@/test/dsWindows';
import type { Conversation } from '@/types';
import FilesTab from './FilesTab';

const ALPHA = '/work/alpha';
const BETA = '/work/beta';
const CONVERSATION_ID = 'conv-files-tab';

function conversation(): Conversation {
  return {
    id: CONVERSATION_ID,
    title: 'Files tab',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    status: 'idle',
    workspacePath: null,
  };
}

function entry(name: string, isDirectory: boolean) {
  return { name, isDirectory, isFile: !isDirectory, isSymlink: false };
}

function renderTab() {
  return render(
    <DesignSystemProvider>
      <FilesTab />
    </DesignSystemProvider>,
  );
}

describe('FilesTab', () => {
  beforeAll(() => {
    // happy-dom has no pointer capture; Radix layers call it.
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
  });

  beforeEach(() => {
    initLanguage('en-US');
    vi.mocked(openDialog).mockReset().mockResolvedValue(null);
    vi.mocked(readDir).mockReset().mockImplementation(async (path) => (
      String(path) === ALPHA
        ? [entry('report.md', false), entry('data', true)]
        : [entry('notes.txt', false)]
    ));
    useChatStore.setState({ activeConversationId: CONVERSATION_ID, conversations: { [CONVERSATION_ID]: conversation() } });
    usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {} });
    useWorkspaceStore.setState({ currentPath: null, recentPaths: [] });
  });

  afterEach(() => cleanup());

  it('lists the first level of the workspace folder, folders first', async () => {
    useWorkspaceStore.setState({ currentPath: ALPHA });
    renderTab();

    const data = await screen.findByRole('button', { name: 'data' });
    const report = screen.getByRole('button', { name: 'report.md' });
    expect(data.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(readDir).toHaveBeenCalledWith(ALPHA);
  });

  it('says that no workspace is selected and lists the chosen folder at once when it already has access', async () => {
    const user = userEvent.setup();
    usePermissionStore.getState().grantPermission(BETA, ['read', 'write', 'execute'], 'session');
    vi.mocked(openDialog).mockResolvedValue(BETA);
    renderTab();

    expect(screen.getByText('No workspace selected yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Select Workspace' }));

    expect(await screen.findByRole('button', { name: 'notes.txt' })).toBeInTheDocument();
    expect(useWorkspaceStore.getState().currentPath).toBe(BETA);
    // The folder is the conversation's own from now on, not only the one in view.
    expect(useChatStore.getState().conversations[CONVERSATION_ID].workspacePath).toBe(BETA);
    expect(screen.queryByText('No workspace selected yet')).not.toBeInTheDocument();
  });

  it('asks for access to a folder that has none, and lists it once access is given', async () => {
    const user = userEvent.setup();
    vi.mocked(openDialog).mockResolvedValue(BETA);
    renderTab();

    await user.click(screen.getByRole('button', { name: 'Select Workspace' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Workspace Access' });
    expect(dialog).toHaveTextContent(BETA);
    expect(useWorkspaceStore.getState().currentPath).toBeNull();

    await passSettleInterval();
    await user.click(screen.getByRole('button', { name: 'Allow for Session' }));

    expect(await screen.findByRole('button', { name: 'notes.txt' })).toBeInTheDocument();
    expect(useWorkspaceStore.getState().currentPath).toBe(BETA);
  });

  it('keeps the state without a workspace when the folder picker is dismissed', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByRole('button', { name: 'Select Workspace' }));

    await waitFor(() => expect(openDialog).toHaveBeenCalledTimes(1));
    expect(screen.getByText('No workspace selected yet')).toBeInTheDocument();
    expect(useWorkspaceStore.getState().currentPath).toBeNull();
  });
});
