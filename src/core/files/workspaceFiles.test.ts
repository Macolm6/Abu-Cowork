import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  checkReadPath: vi.fn(),
  getConversation: vi.fn(),
}));

vi.mock('@/core/tools/fsBridge', () => ({ listWorkspaceFiles: mocks.listWorkspaceFiles }));
vi.mock('@/core/tools/pathSafety', () => ({ checkReadPath: mocks.checkReadPath }));
vi.mock('@/core/agent/ports/conversationReader', () => ({
  getConversationReader: () => ({ getConversation: mocks.getConversation }),
}));

import { listConversationWorkspaceFiles, WorkspaceListRefusedError } from './workspaceFiles';

describe('listConversationWorkspaceFiles', () => {
  beforeEach(() => {
    mocks.listWorkspaceFiles.mockReset();
    mocks.checkReadPath.mockReset();
    mocks.getConversation.mockReset();
    mocks.getConversation.mockReturnValue({ id: 'conv-1', workspacePath: '/Users/me/project' });
    mocks.checkReadPath.mockResolvedValue({ allowed: true, resolvedPath: '/Users/me/project' });
    mocks.listWorkspaceFiles.mockResolvedValue({ exceeded: false, files: [] });
  });

  it('lists the workspace of the conversation with the default limits', async () => {
    mocks.listWorkspaceFiles.mockResolvedValue({ exceeded: false, files: [{ path: 'a.md', size: 1, mtimeMs: 5 }] });

    const result = await listConversationWorkspaceFiles('conv-1', '/Users/me/project');

    expect(result).toEqual({ exceeded: false, files: [{ path: 'a.md', size: 1, mtimeMs: 5 }], root: '/Users/me/project' });
    expect(mocks.listWorkspaceFiles).toHaveBeenCalledWith('/Users/me/project', { maxEntries: 20000, maxDepth: 12 });
  });

  it('returns the folder as the read-path check resolved it', async () => {
    mocks.getConversation.mockReturnValue({ id: 'conv-1', workspacePath: '/var/work/project' });
    mocks.checkReadPath.mockResolvedValue({ allowed: true, resolvedPath: '/private/var/work/project' });
    mocks.listWorkspaceFiles.mockResolvedValue({ exceeded: true });

    await expect(listConversationWorkspaceFiles('conv-1', '/var/work/project'))
      .resolves.toEqual({ exceeded: true, root: '/private/var/work/project' });
    expect(mocks.listWorkspaceFiles).toHaveBeenCalledWith('/var/work/project', expect.anything());
  });

  it('treats separators and a trailing slash as the same folder', async () => {
    mocks.getConversation.mockReturnValue({ id: 'conv-1', workspacePath: 'C:\\work\\project\\' });
    await listConversationWorkspaceFiles('conv-1', 'C:/work/project');
    expect(mocks.listWorkspaceFiles).toHaveBeenCalledTimes(1);
  });

  it('refuses a folder that is not the workspace of the conversation', async () => {
    await expect(listConversationWorkspaceFiles('conv-1', '/Users/me/other'))
      .rejects.toMatchObject({ name: 'WorkspaceListRefusedError', code: 'not_conversation_workspace' });
    await expect(listConversationWorkspaceFiles('conv-1', '/Users/me/project/sub'))
      .rejects.toBeInstanceOf(WorkspaceListRefusedError);
    await expect(listConversationWorkspaceFiles('conv-1', '/Users/me'))
      .rejects.toBeInstanceOf(WorkspaceListRefusedError);
    expect(mocks.checkReadPath).not.toHaveBeenCalled();
    expect(mocks.listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it('refuses when the conversation is unknown or has no workspace', async () => {
    mocks.getConversation.mockReturnValue(undefined);
    await expect(listConversationWorkspaceFiles('conv-9', '/Users/me/project'))
      .rejects.toMatchObject({ code: 'not_conversation_workspace' });
    mocks.getConversation.mockReturnValue({ id: 'conv-1', workspacePath: null });
    await expect(listConversationWorkspaceFiles('conv-1', '/Users/me/project'))
      .rejects.toMatchObject({ code: 'not_conversation_workspace' });
    expect(mocks.listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it('refuses a workspace the read-path check does not allow', async () => {
    mocks.checkReadPath.mockResolvedValue({ allowed: false, needsPermission: true });

    await expect(listConversationWorkspaceFiles('conv-1', '/Users/me/project'))
      .rejects.toMatchObject({ code: 'read_not_allowed' });
    expect(mocks.listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it('checks the read path inside the authorization scope it is given', async () => {
    await listConversationWorkspaceFiles('conv-1', '/Users/me/project', 'scope-7');
    expect(mocks.checkReadPath).toHaveBeenCalledWith('/Users/me/project', 'scope-7');
  });

  it('never puts the path into the refusal message', async () => {
    const error = await listConversationWorkspaceFiles('conv-1', '/Users/me/other').catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('/Users/me');
  });
});
