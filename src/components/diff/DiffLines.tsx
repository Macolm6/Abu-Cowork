import { useMemo, useState } from 'react';
import { Button } from '@/components/ds/button';
import { format, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { FileChangeHunk } from '@/types/fileChange';

type DiffRowKind = 'added' | 'deleted' | 'context';

interface DiffRow {
  kind: DiffRowKind;
  oldNumber?: number;
  newNumber?: number;
  text: string;
  /** First row of a hunk that follows another hunk. */
  startsHunk: boolean;
}

/** Rows shown before and after the folded middle of a long diff. */
export interface DiffFold {
  head: number;
  tail: number;
}

const ROW_CLASS: Record<DiffRowKind, string> = {
  added: 'bg-success-soft text-success',
  deleted: 'bg-danger-soft text-danger',
  context: 'text-label-secondary',
};

const MARKER: Record<DiffRowKind, string> = { added: '+', deleted: '-', context: '' };

function toRows(hunks: FileChangeHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    let oldNumber = hunk.oldStart;
    let newNumber = hunk.newStart;
    hunk.lines.forEach((line, lineIndex) => {
      const startsHunk = hunkIndex > 0 && lineIndex === 0;
      const text = line.slice(1);
      if (line.startsWith('+')) {
        rows.push({ kind: 'added', newNumber: newNumber++, text, startsHunk });
      } else if (line.startsWith('-')) {
        rows.push({ kind: 'deleted', oldNumber: oldNumber++, text, startsHunk });
      } else {
        rows.push({ kind: 'context', oldNumber: oldNumber++, newNumber: newNumber++, text, startsHunk });
      }
    });
  });
  return rows;
}

function DiffRowView({ row }: { row: DiffRow }) {
  return (
    <div
      data-diff-row={row.kind}
      className={cn('flex', ROW_CLASS[row.kind], row.startsHunk && 'border-t border-separator')}
    >
      <span className="w-10 shrink-0 select-none px-1 text-right">{row.oldNumber}</span>
      <span className="w-10 shrink-0 select-none px-1 text-right">{row.newNumber}</span>
      <span className="w-4 shrink-0 select-none text-center">{MARKER[row.kind]}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3">{row.text}</span>
    </div>
  );
}

/**
 * Unified diff of one file: each line with its old and new line number.
 * With `fold`, a diff longer than `head + tail` rows shows only those rows
 * until its button is pressed. `cut` says the hunks stop before the end of the
 * change, and closes the full list with a line that tells the reader so.
 */
export function DiffLines({ hunks, fold, cut = false, className }: {
  hunks: FileChangeHunk[];
  fold?: DiffFold;
  cut?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const rows = useMemo(() => toRows(hunks), [hunks]);
  const [showAll, setShowAll] = useState(false);

  if (rows.length === 0) return null;

  const folded = fold !== undefined && !showAll && rows.length > fold.head + fold.tail;
  const head = folded ? rows.slice(0, fold.head) : rows;
  const tail = folded ? rows.slice(rows.length - fold.tail) : [];

  return (
    <div className={cn('overflow-hidden rounded-panel bg-code py-1 font-code text-mono', className)}>
      {head.map((row, index) => <DiffRowView key={index} row={row} />)}
      {folded && (
        <div className="px-1 py-1">
          <Button variant="plain" size="sm" onClick={() => setShowAll(true)}>
            {format(t.chat.showAllDiffLines, { count: rows.length })}
          </Button>
        </div>
      )}
      {tail.map((row, index) => <DiffRowView key={rows.length - tail.length + index} row={row} />)}
      {cut && !folded && (
        <div className="px-3 pt-1 font-sans text-caption text-label-tertiary">{t.chat.diffCut}</div>
      )}
    </div>
  );
}
