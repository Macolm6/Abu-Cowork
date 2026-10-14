import { useCallback } from 'react';
import PermissionDialog from '@/components/common/PermissionDialog';
import WorkspaceFileTree from '../WorkspaceFileTree';
import { useSelectWorkspace } from '../useSelectWorkspace';

/**
 * The "workspace files" (工作区文件) tab body: the file tree of the conversation's
 * workspace folder, and the way to choose a folder while there is none.
 */
export default function FilesTab() {
  const { pendingFolder, selectWorkspace, allow, deny } = useSelectWorkspace();
  const handleSelectWorkspace = useCallback(() => { void selectWorkspace(); }, [selectWorkspace]);

  return (
    <>
      {pendingFolder && (
        <PermissionDialog
          request={{ type: 'workspace', path: pendingFolder }}
          onAllow={allow}
          onDeny={deny}
        />
      )}
      <WorkspaceFileTree onSelectWorkspace={handleSelectWorkspace} />
    </>
  );
}
