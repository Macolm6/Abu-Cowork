import { getConversationReader } from '@/core/agent/ports/conversationReader';
import { listWorkspaceFiles } from '@/core/tools/fsBridge';
import { checkReadPath, type AuthorizationScopeId } from '@/core/tools/pathSafety';
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
 * Lists the files of a conversation's workspace. `root` has to be that
 * conversation's workspace folder and has to pass the read-path check the file
 * tools apply; the host call behind it checks neither.
 */
export async function listConversationWorkspaceFiles(
  conversationId: string,
  root: string,
  scopeId?: AuthorizationScopeId,
): Promise<WorkspaceFileList> {
  const workspacePath = getConversationReader().getConversation(conversationId)?.workspacePath;
  if (!workspacePath || comparableFolder(workspacePath) !== comparableFolder(root)) {
    throw new WorkspaceListRefusedError('not_conversation_workspace');
  }
  const check = await checkReadPath(root, scopeId);
  if (!check.allowed) throw new WorkspaceListRefusedError('read_not_allowed');
  return listWorkspaceFiles(root, { maxEntries: WORKSPACE_LIST_MAX_ENTRIES, maxDepth: WORKSPACE_LIST_MAX_DEPTH });
}
