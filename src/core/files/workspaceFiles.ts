import { getConversationReader } from '@/core/agent/ports/conversationReader';
import { listWorkspaceFiles } from '@/core/tools/fsBridge';
import { checkReadPath, type AuthorizationScopeId } from '@/core/tools/pathSafety';
import type { ToolFileAccess } from '@/core/tools/fileOperation';
import { SKIPPED_WORKSPACE_DIRECTORIES } from './workspaceFileWalk';
import {
  WORKSPACE_LIST_MAX_DEPTH,
  WORKSPACE_LIST_MAX_ENTRIES,
  type WorkspaceFileList,
} from './workspaceFileWalk';

export type { WorkspaceFileEntry, WorkspaceFileList } from './workspaceFileWalk';

export type WorkspaceListRefusal = 'not_conversation_workspace' | 'read_not_allowed';

export class WorkspaceListRefusedError extends Error {
  readonly code: WorkspaceListRefusal;
  constructor(code: WorkspaceListRefusal) {
    // The folder is the user's own path, so it stays out of the message and of any log that prints it.
    super(`Workspace file list refused (${code})`);
    this.name = 'WorkspaceListRefusedError';
    this.code = code;
  }
}

function comparableFolder(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}

/**
 * A workspace list together with the folder as the read-path check resolved
 * it (links followed), which is the spelling the file tools write under.
 */
export type ConversationWorkspaceFiles = WorkspaceFileList & { root: string };

/**
 * Lists the files of a conversation's workspace. `root` has to be that
 * conversation's workspace folder and has to pass the read-path check the file
 * tools apply; the host call behind it checks neither.
 */
export async function listConversationWorkspaceFiles(
  conversationId: string,
  root: string,
  scopeId?: AuthorizationScopeId,
  files?: ToolFileAccess,
): Promise<ConversationWorkspaceFiles> {
  const workspacePath = getConversationReader().getConversation(conversationId)?.workspacePath;
  if (!workspacePath || comparableFolder(workspacePath) !== comparableFolder(root)) {
    throw new WorkspaceListRefusedError('not_conversation_workspace');
  }
  const check = await checkReadPath(root, scopeId);
  if (!check.allowed) throw new WorkspaceListRefusedError('read_not_allowed');
  if (files) {
    const entries = [];
    const lexicalRoot = comparableFolder(root);
    for await (const entry of files.walkFiles(root, {
      excludeNames: SKIPPED_WORKSPACE_DIRECTORIES, skipHiddenDirectories: true,
      skipSymlinks: true, maxDepth: WORKSPACE_LIST_MAX_DEPTH,
    })) {
      if (entry.name === '.DS_Store') continue;
      if (entries.length >= WORKSPACE_LIST_MAX_ENTRIES) return { exceeded: true, root: comparableFolder(String(files.executionInput.path)) };
      const info = await files.stat(entry.path);
      entries.push({ path: entry.path.slice(lexicalRoot.length + 1), size: info.size,
        mtimeMs: info.mtime instanceof Date ? Math.floor(info.mtime.getTime()) : null });
    }
    entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return { exceeded: false, files: entries, root: comparableFolder(String(files.executionInput.path)) };
  }
  const list = await listWorkspaceFiles(root, { maxEntries: WORKSPACE_LIST_MAX_ENTRIES, maxDepth: WORKSPACE_LIST_MAX_DEPTH });
  return { ...list, root: comparableFolder(check.resolvedPath ?? root) };
}
