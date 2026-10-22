import { useMemo } from 'react';
import { Disclosure } from '@/components/ds/disclosure';
import { Tag } from '@/components/ds/tag';
import { format, useI18n, type TranslationDict } from '@/i18n';
import { foldRowList } from '@/utils/toolResultFold';
import { groupSearchRows, parseSearchResult, type SearchHeader, type SearchRow } from '@/utils/toolViews/searchView';
import { ResultNote } from '@/components/chat/DetailBlockView';
import { FoldedRows } from './FoldedRows';
import type { StepViewStatus } from './CommandStepView';

const isMatch = (row: SearchRow) => row.kind === 'match';

function headerText(header: SearchHeader, t: TranslationDict): string {
  if (header.kind === 'count') return format(t.task.searchSummary, { matches: header.matches, files: header.files });
  if (header.kind === 'capped') return format(t.task.searchCapped, { matches: header.matches });
  return t.task.searchNoMatches;
}

/** Visible rows as one group per file, each line with its number; a note on a line of its own. */
function SearchRows({ visible, all, t }: { visible: readonly SearchRow[]; all: readonly SearchRow[]; t: TranslationDict }) {
  return (
    <>
      {groupSearchRows(visible, all).map((segment, index) => (segment.kind === 'group' ? (
        <Disclosure
          key={index}
          defaultOpen
          title={<>{segment.path} <Tag>{format(t.task.searchGroupCount, { count: segment.count })}</Tag></>}
        >
          {segment.rows.map((row, rowIndex) => (
            <div key={rowIndex} className="flex gap-3 font-code text-mono">
              <span className="shrink-0 select-none text-label-tertiary">{row.line}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{row.text}</span>
            </div>
          ))}
        </Disclosure>
      ) : (
        <ResultNote key={index} row={segment} t={t} />
      )))}
    </>
  );
}

/** A search_files step: the pattern, then the matches grouped by file. */
export function SearchStepView({ pattern, status, text }: {
  pattern: string;
  status: StepViewStatus;
  text: string;
}) {
  const { t } = useI18n();
  const completed = status === 'completed';
  const view = useMemo(() => {
    if (!completed) return null;
    const search = parseSearchResult(text);
    return { header: search.header, fold: foldRowList(search.rows, isMatch) };
  }, [completed, text]);

  return (
    <div className="overflow-hidden rounded-panel bg-code">
      <div className="whitespace-pre-wrap break-all px-3 py-2 font-code text-mono text-label">{pattern}</div>
      {view && (
        <div className="border-t border-separator">
          <div className="px-3 py-2 text-caption text-label-tertiary">{headerText(view.header, t)}</div>
          {view.header.kind !== 'none' && view.fold.rows.length > 0 && (
            <FoldedRows
              fold={view.fold}
              renderRows={(rows) => <SearchRows visible={rows} all={view.fold.rows} t={t} />}
              className="pt-0 text-label"
            />
          )}
        </div>
      )}
    </div>
  );
}
