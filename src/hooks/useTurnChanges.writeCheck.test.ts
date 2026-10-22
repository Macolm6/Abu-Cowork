// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeWorkspace, checkWritePath, revokeWorkspace } from '@/core/tools/pathSafety';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation } from '@/types';

/**
 * The authorization `useTurnUndo` hands to an undo, over the real write check.
 * Only the host's path resolution is replaced: `links` maps a link to its
 * target, and a path is resolved by following every link on its way.
 */
const mocks = vi.hoisted(() => ({
  undoTurn: vi.fn(),
  links: new Map<string, string>(),
}));

vi.mock('@/core/session/turnUndo', () => ({
  planTurnUndo: vi.fn(),
  reapplyTurn: vi.fn(),
  undoTurn: (...args: unknown[]) => mocks.undoTurn(...args),
}));

vi.mock('@/utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: async (path: string) => {
    let resolved = path;
    for (let hop = 0; hop < 8; hop++) {
      const link = [...mocks.links.keys()].find((from) => resolved === from || resolved.startsWith(`${from}/`));
      if (!link) break;
      resolved = `${mocks.links.get(link)}${resolved.slice(link.length)}`;
    }
    return resolved;
  },
}));

import { __testing, useTurnUndo } from './useTurnChanges';

const HOME = '/Users/testuser';
const granted: string[] = [];

/** A conversation in `workspacePath`, with the write grant the app gives the workspace of a conversation. */
function openWorkspace(workspacePath: string, links: Record<string, string> = {}): void {
  for (const [from, to] of Object.entries(links)) mocks.links.set(from, to);
  authorizeWorkspace(workspacePath);
  granted.push(workspacePath);
  const conversation: Conversation = {
    id: 'conv-1', title: 'conv-1', messages: [], createdAt: 1_000, updatedAt: 1_000, status: 'idle', workspacePath,
  };
  useChatStore.setState({ conversations: { 'conv-1': conversation } });
}

/** The authorization an undo of a turn of the conversation is run with. */
async function undoAuthorization(): Promise<(path: string) => Promise<boolean>> {
  const { result } = renderHook(() => useTurnUndo('conv-1', 'loop-1'));
  await act(async () => { await result.current.run('undo'); });
  return (mocks.undoTurn.mock.calls[0][2] as { authorize: (path: string) => Promise<boolean> }).authorize;
}

describe('useTurnUndo over the real write check', () => {
  beforeEach(() => {
    __testing.reset();
    mocks.undoTurn.mockReset();
    mocks.undoTurn.mockResolvedValue({ done: 0, notDone: [] });
    mocks.links.clear();
  });

  afterEach(() => {
    cleanup();
    for (const path of granted.splice(0)) revokeWorkspace(path);
  });

  it('authorizes a file of the workspace in the recorded, resolved spelling and in the spelling of the workspace', async () => {
    openWorkspace(`${HOME}/Projects/link`, { [`${HOME}/Projects/link`]: `${HOME}/Projects/app` });
    const authorize = await undoAuthorization();

    await expect(authorize(`${HOME}/Projects/app/docs/a.md`)).resolves.toBe(true);
    await expect(authorize(`${HOME}/Projects/link/docs/a.md`)).resolves.toBe(true);
  });

  it('refuses every file of a workspace that is a link to a sensitive folder', async () => {
    openWorkspace(`${HOME}/Projects/keys`, { [`${HOME}/Projects/keys`]: `${HOME}/.ssh` });
    const authorize = await undoAuthorization();

    await expect(authorize(`${HOME}/.ssh/config`)).resolves.toBe(false);
    await expect(authorize(`${HOME}/Projects/keys/config`)).resolves.toBe(false);
    // The write check blocks the folder the link leads to; no grant can be asked for.
    await expect(checkWritePath(`${HOME}/Projects/keys/config`)).resolves.not.toHaveProperty('needsPermission');
  });

  it('refuses a file under the workspace that is reached through a link to a folder outside it', async () => {
    openWorkspace(`${HOME}/Projects/link`, {
      [`${HOME}/Projects/link`]: `${HOME}/Projects/app`,
      [`${HOME}/Projects/app/shared`]: `${HOME}/Documents/private`,
    });
    const authorize = await undoAuthorization();

    await expect(authorize(`${HOME}/Projects/app/shared/notes.md`)).resolves.toBe(false);
    await expect(authorize(`${HOME}/Projects/link/shared/notes.md`)).resolves.toBe(false);
    await expect(authorize(`${HOME}/Projects/app/own/notes.md`)).resolves.toBe(true);
  });

  it('refuses a file of a sibling folder whose name starts with the name of the workspace', async () => {
    openWorkspace('/a/work');
    const authorize = await undoAuthorization();

    await expect(authorize('/a/workspace-other/x')).resolves.toBe(false);
    await expect(authorize('/a/work/x')).resolves.toBe(true);
  });

  it('refuses a sibling of the resolved workspace folder whose name starts with its name', async () => {
    openWorkspace('/a/link', { '/a/link': '/a/work' });
    const authorize = await undoAuthorization();

    await expect(authorize('/a/workspace-other/x')).resolves.toBe(false);
    await expect(authorize('/a/work/x')).resolves.toBe(true);
  });

  it('refuses a file outside the workspace', async () => {
    openWorkspace(`${HOME}/Projects/app`);
    const authorize = await undoAuthorization();

    await expect(authorize(`${HOME}/Documents/elsewhere/x.md`)).resolves.toBe(false);
    await expect(authorize(`${HOME}/Projects/app/x.md`)).resolves.toBe(true);
  });
});
