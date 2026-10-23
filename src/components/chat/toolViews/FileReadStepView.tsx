import { useMemo } from 'react';
import { format, useI18n, type TranslationDict } from '@/i18n';
import type { FileReadOutcome } from '@/types';
import { foldRowList, foldToolResult, type ToolResultRow } from '@/utils/toolResultFold';
import { fileReadView, type NumberedRow } from '@/utils/toolViews/fileReadView';
import { ResultNote, ResultRows } from '@/components/chat/DetailBlockView';
import { FoldedRows } from './FoldedRows';
import type { StepViewStatus } from './CommandStepView';

type LineGroup = { kind: 'lines'; numbers: string[]; texts: string[] };

/** Runs of numbered lines as a number column beside the text, a note on a line of its own. */
function NumberedRows({ rows, t }: { rows: readonly NumberedRow[]; t: TranslationDict }) {
  const groups: (LineGroup | Extract<NumberedRow, { kind: 'note' }>)[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (row.kind === 'note') groups.push(row);
    else if (last?.kind === 'lines') {
      last.numbers.push(row.number === null ? '' : String(row.number));
      last.texts.push(row.text);
    } else {
      groups.push({ kind: 'lines', numbers: [row.number === null ? '' : String(row.number)], texts: [row.text] });
    }
  }
  return (
    <>
      {groups.map((group, index) => (group.kind === 'lines' ? (
        <div key={index} className="flex gap-3">
          <pre data-line-numbers className="m-0 shrink-0 select-none text-right font-code text-mono text-label-tertiary">
            {group.numbers.join('\n')}
          </pre>
          <pre className="m-0 min-w-0 flex-1 overflow-x-auto whitespace-pre font-code text-mono">{group.texts.join('\n')}</pre>
        </div>
      ) : (
        <ResultNote key={index} row={group} t={t} />
      )))}
    </>
  );
}

const isLine = (row: NumberedRow) => row.kind === 'line';

/** A read_file step: the path, then the lines read with their numbers. */
export function FileReadStepView({ path, status, outcome, text }: {
  path: string;
  status: StepViewStatus;
  outcome: FileReadOutcome | undefined;
  text: string;
}) {
  const { t } = useI18n();
  const completed = status === 'completed';
  const view = useMemo(() => {
    if (!completed) return null;
    const read = fileReadView(text, outcome);
    return {
      header: read.header,
      numbered: read.numbered && foldRowList(read.numbered, isLine),
      plain: read.plain && foldToolResult(text),
    };
  }, [completed, text, outcome]);

  return (
    <div className="overflow-hidden rounded-panel bg-code">
      <div className="whitespace-pre-wrap break-all px-3 py-2 font-code text-mono text-label">{path}</div>
      {view && (
        <div className="border-t border-separator">
          {view.header && (
            <div className="px-3 pt-2 text-caption text-label-tertiary">
              {view.header.kind === 'all'
                ? format(t.task.readAllLines, { count: view.header.count })
                : format(t.task.readLineRange, { start: view.header.start, end: view.header.end, total: view.header.total })}
            </div>
          )}
          {view.numbered && (
            <FoldedRows
              fold={view.numbered}
              renderRows={(rows) => <NumberedRows rows={rows} t={t} />}
              className="text-label"
            />
          )}
          {view.plain && (
            <FoldedRows
              fold={view.plain}
              renderRows={(rows: readonly ToolResultRow[]) => <ResultRows rows={rows} t={t} />}
              className="text-label"
            />
          )}
        </div>
      )}
    </div>
  );
}
