import { useRef, useState, type ReactNode } from 'react';
import { Menu, MenuLabel } from '@/components/ds/menu';
import { usePreviewStore } from '@/stores/previewStore';
import type { VersionMeta } from '@/utils/canvasVersions';
import { useI18n } from '@/i18n';
import { VersionList, VersionRestoreDialog } from './VersionList';

interface VersionHistoryMenuProps {
  /** Absolute path of the file this history belongs to. */
  filePath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button that opens the menu. */
  trigger: ReactNode;
}

/**
 * Menu listing every version of a file (see `@/utils/canvasVersions`), in the
 * preview's title row. Choosing a version asks first, once the menu has gone;
 * the answer restores the file through the preview that shows it.
 */
export function VersionHistoryMenu({ filePath, open, onOpenChange, trigger }: VersionHistoryMenuProps) {
  const { t } = useI18n();
  const conversationId = usePreviewStore((s) => s.currentConversationId);
  const picked = useRef<VersionMeta | null>(null);
  const [asking, setAsking] = useState<VersionMeta | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (next) picked.current = null;
    onOpenChange(next);
  };

  // The question opens after the menu has given the focus back to its button,
  // which the question returns to when it closes.
  const handleCloseAutoFocus = () => {
    const version = picked.current;
    picked.current = null;
    if (version) setAsking(version);
  };

  return (
    <>
      <Menu align="end" open={open} onOpenChange={handleOpenChange} onCloseAutoFocus={handleCloseAutoFocus} trigger={trigger}>
        <MenuLabel>{t.panel.versionHistory}</MenuLabel>
        <VersionList filePath={filePath} onPick={(version) => { picked.current = version; }} />
      </Menu>
      <VersionRestoreDialog
        filePath={filePath}
        version={asking}
        origin={conversationId ? { conversationId } : null}
        onClose={() => setAsking(null)}
      />
    </>
  );
}
