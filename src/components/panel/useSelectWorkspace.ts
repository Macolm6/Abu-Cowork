import { useCallback, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useChatStore } from '@/stores/chatStore';
import { usePermissionStore, type PermissionDuration } from '@/stores/permissionStore';
import { useI18n } from '@/i18n';

export interface SelectWorkspaceResult {
  /** The folder waiting for the access dialog, or null. The caller renders the dialog for it. */
  pendingFolder: string | null;
  /** Ask the system folder picker for a folder and make it the workspace. */
  selectWorkspace: () => Promise<void>;
  /** Make `path` the workspace: at once when it already has read access, else after the access dialog. */
  switchTo: (path: string) => void;
  /** Whether switching to `path` opens the access dialog. */
  needsAccess: (path: string) => boolean;
  allow: (duration: PermissionDuration) => void;
  deny: () => void;
}

/**
 * Choosing the workspace folder from the right panel: the folder becomes the
 * global workspace and the active conversation's own, after the access dialog
 * when the folder has no read access yet.
 */
export function useSelectWorkspace(): SelectWorkspaceResult {
  const { t } = useI18n();
  const setWorkspaceGlobal = useWorkspaceStore((s) => s.setWorkspace);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const setConversationWorkspace = useChatStore((s) => s.setConversationWorkspace);
  const grantPermission = usePermissionStore((s) => s.grantPermission);
  const hasPermission = usePermissionStore((s) => s.hasPermission);
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);

  const setWorkspace = useCallback((path: string) => {
    setWorkspaceGlobal(path);
    if (activeConversationId) setConversationWorkspace(activeConversationId, path);
  }, [setWorkspaceGlobal, activeConversationId, setConversationWorkspace]);

  const needsAccess = useCallback((path: string) => !hasPermission(path, 'read'), [hasPermission]);

  const switchTo = useCallback((path: string) => {
    if (needsAccess(path)) setPendingFolder(path);
    else setWorkspace(path);
  }, [needsAccess, setWorkspace]);

  const selectWorkspace = useCallback(async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: t.panel.selectWorkspace });
      if (selected) switchTo(selected as string);
    } catch (err) {
      console.error('Failed to select workspace:', err);
    }
  }, [t, switchTo]);

  const allow = useCallback((duration: PermissionDuration) => {
    if (!pendingFolder) return;
    grantPermission(pendingFolder, ['read', 'write', 'execute'], duration);
    setWorkspace(pendingFolder);
    setPendingFolder(null);
  }, [pendingFolder, grantPermission, setWorkspace]);

  const deny = useCallback(() => setPendingFolder(null), []);

  return { pendingFolder, selectWorkspace, switchTo, needsAccess, allow, deny };
}
