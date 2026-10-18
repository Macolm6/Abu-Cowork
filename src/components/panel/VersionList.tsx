import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/ds/confirm-dialog';
import { AppIcons } from '@/components/ds/icons';
import { MenuItem } from '@/components/ds/menu';
import { Spinner } from '@/components/ds/spinner';
import { Tag } from '@/components/ds/tag';
import { format, useI18n } from '@/i18n';
import { useToastStore } from '@/stores/toastStore';
import { listVersions, REVERT_LABEL, type VersionMeta, type VersionOrigin } from '@/utils/canvasVersions';
import { getBaseName } from '@/utils/pathUtils';
import { revertFileVersion } from '@/utils/revertFileVersion';
import { formatVersionTime } from './versionTime';

type ListState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; versions: VersionMeta[] };

/**
 * The versions of a file as menu items, most recent first, read when the list
 * is shown (it mounts with the menu or nested list that holds it). With
 * `conversationId`, only the versions that conversation left. Each row is the
 * time with the version's mark, and the user message of its turn on a second
 * line. Choosing a version hands it to `onPick`.
 */
export function VersionList({ filePath, conversationId, onPick }: {
  filePath: string;
  conversationId?: string;
  onPick: (version: VersionMeta) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<ListState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    listVersions(filePath, conversationId ? { conversationId } : undefined).then(
      (versions) => { if (!cancelled) setState({ status: 'ready', versions }); },
      (err: unknown) => {
        console.error('[VersionList] Failed to list versions:', filePath, err);
        if (!cancelled) setState({ status: 'failed' });
      },
    );
    return () => { cancelled = true; };
  }, [filePath, conversationId]);

  if (state.status === 'loading') {
    return (
      <div className="flex justify-center px-2 py-3">
        <Spinner size="sm" label={t.common.loading} />
      </div>
    );
  }
  if (state.status === 'failed') {
    return <p className="px-2 py-3 text-center text-ui-sm text-label-tertiary">{t.panel.versionHistoryLoadFailed}</p>;
  }
  if (state.versions.length === 0) {
    return <p className="px-2 py-3 text-center text-ui-sm text-label-tertiary">{t.panel.versionHistoryEmpty}</p>;
  }
  return (
    // A file can hold 31 versions: the list keeps a compact height and scrolls.
    <div className="max-h-80 overflow-y-auto">
      {state.versions.map((v) => {
        const restorePoint = v.label === REVERT_LABEL;
        const mark = restorePoint ? t.panel.versionRevertPoint : v.source === 'ai' ? t.panel.versionSourceAi : null;
        const prompt = restorePoint ? undefined : v.label;
        return (
          <MenuItem
            key={v.id}
            icon={AppIcons.clock}
            title={t.panel.versionHistoryRevert}
            description={prompt ? <span className="block truncate">{prompt}</span> : undefined}
            onSelect={() => onPick(v)}
          >
            {/* The tag's height on every row, so rows with and without it are equally tall. */}
            <span className="flex h-5 items-center gap-2">
              <span className="tabular-nums">{formatVersionTime(v.ts)}</span>
              {mark && <Tag tone={restorePoint ? 'neutral' : 'info'}>{mark}</Tag>}
            </span>
          </MenuItem>
        );
      })}
    </div>
  );
}

/**
 * The question before a version is restored. Shown while `version` is set;
 * it keeps what it showed while it fades. Restoring goes through
 * `revertFileVersion`, so a preview that shows the file follows it, and ends
 * with a notice either way.
 */
export function VersionRestoreDialog({ filePath, version, origin, onClose }: {
  filePath: string;
  version: VersionMeta | null;
  origin: VersionOrigin | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [held, setHeld] = useState<VersionMeta | null>(version);
  if (version && version !== held) setHeld(version);
  const shown = version ?? held;

  const onResult = async (confirmed: boolean): Promise<void> => {
    const picked = version;
    onClose();
    if (!confirmed || !picked) return;
    const addToast = useToastStore.getState().addToast;
    try {
      await revertFileVersion(filePath, picked.id, origin);
      addToast({ type: 'success', title: t.panel.versionHistoryReverted });
    } catch (err) {
      console.error('[VersionRestoreDialog] Revert failed:', filePath, picked.id, err);
      addToast({
        type: 'error',
        title: t.panel.versionHistoryRevertFailedTitle,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <ConfirmDialog
      open={version !== null}
      title={shown ? format(t.panel.versionRestoreTitle, { name: getBaseName(filePath), time: formatVersionTime(shown.ts) }) : ''}
      message={t.panel.versionRestoreMessage}
      confirmLabel={t.panel.versionRestoreConfirm}
      onResult={(confirmed) => { void onResult(confirmed); }}
    />
  );
}
