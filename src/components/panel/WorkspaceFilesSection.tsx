import { useCallback } from 'react';
import PermissionDialog from '@/components/common/PermissionDialog';
import { AppIcons } from '@/components/ds/icons';
import { useI18n } from '@/i18n';
import SummarySection from './SummarySection';
import WorkspaceFileTree from './WorkspaceFileTree';
import { useSelectWorkspace } from './useSelectWorkspace';

/**
 * The 「所有文件」 section of the task summary: the workspace folder of the conversation
 * and every file under it, as a tree, and the ways to choose that folder or change it. A
 * folder without read access is asked about first.
 */
export default function WorkspaceFilesSection() {
  const { t } = useI18n();
  const { pendingFolder, selectWorkspace, switchTo, needsAccess, allow, deny } = useSelectWorkspace();
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
      <SummarySection icon={AppIcons.fileTree} title={t.panel.fileTree.title}>
        <WorkspaceFileTree
          onSelectWorkspace={handleSelectWorkspace}
          onSwitchFolder={switchTo}
          folderNeedsAccess={needsAccess}
        />
      </SummarySection>
    </>
  );
}
