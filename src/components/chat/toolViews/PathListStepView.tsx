import { useMemo } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { format, useI18n, type TranslationDict } from '@/i18n';
import { foldRowList } from '@/utils/toolResultFold';
import {
  parseFindResult,
  parseListDirectoryResult,
  type PathListHeader,
  type PathListRow,
} from '@/utils/toolViews/pathListView';
import { ResultNote } from '@/components/chat/DetailBlockView';
import { FoldedRows } from './FoldedRows';
import type { StepViewStatus } from './CommandStepView';

const isListed = (row: PathListRow) => row.kind !== 'note';

function headerText(header: PathListHeader, t: TranslationDict): string {
  if (header.kind === 'files') return format(t.task.foundFiles, { count: header.count });
  if (header.kind === 'entries') return format(t.task.directoryEntries, { count: header.count });
  return t.task.directoryEmpty;
}

/** One path, or one entry with its folder or file icon, or a note. */
function PathRow({ row, t }: { row: PathListRow; t: TranslationDict }) {
  if (row.kind === 'note') return <ResultNote row={row} t={t} />;
  if (row.kind === 'path') return <div className="whitespace-pre-wrap break-all font-code text-mono">{row.path}</div>;
  return (
    <div className="flex items-center gap-2 font-code text-mono">
      <Icon icon={row.directory ? AppIcons.folder : AppIcons.fileGeneric} size="sm" className="text-label-secondary" />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{row.name}</span>
    </div>
  );
}

/** A find_files or list_directory step: the pattern or folder, then the paths found. */
export function PathListStepView({ kind, subject, status, text }: {
  kind: 'find' | 'list';
  subject: string;
  status: StepViewStatus;
  text: string;
}) {
  const { t } = useI18n();
  const completed = status === 'completed';
  const view = useMemo(() => {
    if (!completed) return null;
    const list = kind === 'find' ? parseFindResult(text) : parseListDirectoryResult(text);
    return { header: list.header, fold: foldRowList(list.rows, isListed) };
  }, [completed, kind, text]);

  if (view?.header.kind === 'empty') {
    return (
      <div className="overflow-hidden rounded-panel bg-code">
        <div className="px-3 py-2 text-caption text-label-tertiary">{t.task.directoryEmpty}</div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-panel bg-code">
      <div className="whitespace-pre-wrap break-all px-3 py-2 font-code text-mono text-label">{subject}</div>
      {view && (
        <div className="border-t border-separator">
          <div className="px-3 py-2 text-caption text-label-tertiary">{headerText(view.header, t)}</div>
          {view.fold.rows.length > 0 && (
            <FoldedRows
              fold={view.fold}
              renderRows={(rows) => rows.map((row, index) => <PathRow key={index} row={row} t={t} />)}
              renderAll={(rows) => (
                <Virtuoso
                  data={rows}
                  className="h-[300px]"
                  itemContent={(_index, row) => <PathRow row={row} t={t} />}
                />
              )}
              className="py-0 text-label"
            />
          )}
        </div>
      )}
    </div>
  );
}
