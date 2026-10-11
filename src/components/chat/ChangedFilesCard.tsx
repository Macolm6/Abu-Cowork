import { memo, useState } from 'react';
import { Pressable } from '@/components/ds/pressable';
import { format, useI18n } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import { usePreviewStore } from '@/stores/previewStore';
import { useTurnChangesDetail, useTurnChangesEntry } from '@/hooks/useTurnChanges';
import type { TurnChangedFile } from '@/core/session/turnChanges';

/** File rows shown before the rest is asked for. */
const MAX_ROWS_SHOWN = 4;

function changeStatusLabel(t: TranslationDict, status: TurnChangedFile['status']): string {
  if (status === 'created') return t.chat.changeCreated;
  if (status === 'deleted') return t.chat.changeDeleted;
  return t.chat.changeModified;
}

/** "+N −M", or the status word of a file that has no line counts. */
export function ChangeAmount({ file }: { file: Pick<TurnChangedFile, 'status' | 'added' | 'deleted'> }) {
  const { t } = useI18n();
  if (file.added === undefined || file.deleted === undefined) {
    return <span className="shrink-0 text-ui-sm text-label-tertiary">{changeStatusLabel(t, file.status)}</span>;
  }
  return <LineCounts added={file.added} deleted={file.deleted} />;
}

function LineCounts({ added, deleted }: { added: number; deleted: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-code text-ui-sm">
      <span className="text-success">+{added}</span>
      <span className="text-danger">−{deleted}</span>
    </span>
  );
}

/**
 * The files a turn changed, under its reply. Renders nothing while the record
 * is being read and for a turn that changed no file. A turn with one file is
 * the title alone. The title and every row open the turn's changes tab.
 */
function ChangedFilesCard({ conversationId, loopId }: { conversationId: string; loopId: string }) {
  const { t } = useI18n();
  const entry = useTurnChangesEntry(conversationId, loopId, true);
  const many = entry !== null && entry.total > 1;
  const detail = useTurnChangesDetail(conversationId, loopId, many);
  const openTurnChanges = usePreviewStore((s) => s.openTurnChanges);
  const [allShown, setAllShown] = useState(false);

  if (!entry) return null;
  if (many && detail.status === 'loading') return null;

  const tabTitle = many
    ? format(t.panel.changesTabMany, { name: entry.firstFile, count: entry.total })
    : format(t.panel.changesTabSingle, { name: entry.firstFile });
  const open = (fileIndex: number) => openTurnChanges({ conversationId, loopId, fileIndex, title: tabTitle });

  const files = many ? detail.turn?.files ?? [] : [];
  const foldable = files.length > MAX_ROWS_SHOWN;
  const shown = foldable && !allShown ? files.slice(0, MAX_ROWS_SHOWN) : files;
  const moreFiles = detail.turn?.moreFiles ?? 0;

  return (
    <div data-testid="changed-files-card" className="mt-2 max-w-xl overflow-hidden rounded-panel border border-separator bg-surface">
      <Pressable
        onClick={() => open(0)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left text-ui text-label transition-colors duration-fast hover:bg-fill-hover"
      >
        <span className="min-w-0 flex-1 truncate">
          {many
            ? format(t.chat.changedFilesTitle, { count: entry.total })
            : format(t.chat.changedFileSingleTitle, { name: entry.firstFile })}
        </span>
        {entry.added + entry.deleted > 0 && <LineCounts added={entry.added} deleted={entry.deleted} />}
      </Pressable>
      {shown.length > 0 && (
        <ul className="border-t border-separator py-1">
          {shown.map((file, index) => (
            <li key={file.path}>
              <Pressable
                onClick={() => open(index)}
                title={file.display}
                className="flex w-full items-center gap-3 px-3 py-1 text-left text-ui-sm text-label-secondary transition-colors duration-fast hover:bg-fill-hover hover:text-label"
              >
                <span className="min-w-0 flex-1 truncate">{file.display}</span>
                <ChangeAmount file={file} />
              </Pressable>
            </li>
          ))}
        </ul>
      )}
      {(!foldable || allShown) && moreFiles > 0 && (
        <div className="px-3 pb-2 text-ui-sm text-label-tertiary">
          {format(t.chat.moreChangedFiles, { count: moreFiles })}
        </div>
      )}
      {foldable && (
        <div className="border-t border-separator px-3 py-1">
          <Pressable
            aria-expanded={allShown}
            onClick={() => setAllShown((value) => !value)}
            className="rounded-control text-ui-sm text-label-secondary transition-colors duration-fast hover:text-label"
          >
            {allShown ? t.chat.collapseFiles : format(t.chat.allFilesCount, { count: entry.total })}
          </Pressable>
        </div>
      )}
    </div>
  );
}

export default memo(ChangedFilesCard);
