import { useMemo } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { FileChangeHunk } from '@/types/fileChange';

type SideKind = 'added' | 'deleted' | 'context';

interface SideCell {
  kind: SideKind;
  number: number;
  text: string;
}

interface SplitRow {
  before?: SideCell;
  after?: SideCell;
  /** First row of a hunk that follows another hunk. */
  startsHunk: boolean;
}

const SIDE_CLASS: Record<SideKind, string> = {
  added: 'bg-success-soft text-success',
  deleted: 'bg-danger-soft text-danger',
  context: 'text-label-secondary',
};

/**
 * Rows of the two-column view: a context line sits on both sides, and a run of
 * deleted lines is paired row by row with the added lines that follow it.
 */
function toSplitRows(hunks: FileChangeHunk[]): SplitRow[] {
  const rows: SplitRow[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    const firstRow = rows.length;
    let oldNumber = hunk.oldStart;
    let newNumber = hunk.newStart;
    let deleted: SideCell[] = [];
    let added: SideCell[] = [];
    const flush = (): void => {
      const count = Math.max(deleted.length, added.length);
      for (let i = 0; i < count; i++) rows.push({ before: deleted[i], after: added[i], startsHunk: false });
      deleted = [];
      added = [];
    };
    for (const line of hunk.lines) {
      const text = line.slice(1);
      if (line.startsWith('-')) {
        if (added.length > 0) flush();
        deleted.push({ kind: 'deleted', number: oldNumber++, text });
      } else if (line.startsWith('+')) {
        added.push({ kind: 'added', number: newNumber++, text });
      } else {
        flush();
        rows.push({
          before: { kind: 'context', number: oldNumber++, text },
          after: { kind: 'context', number: newNumber++, text },
          startsHunk: false,
        });
      }
    }
    flush();
    if (hunkIndex > 0 && rows.length > firstRow) rows[firstRow].startsHunk = true;
  });
  return rows;
}

function SideView({ side, cell }: { side: 'before' | 'after'; cell?: SideCell }) {
  return (
    <div
      data-diff-side={side}
      data-diff-row={cell?.kind}
      className={cn('flex min-w-0', cell && SIDE_CLASS[cell.kind], side === 'after' && 'border-l border-separator')}
    >
      <span data-diff-number className="w-10 shrink-0 select-none px-1 text-right">{cell?.number}</span>
      <span data-diff-text className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">{cell?.text}</span>
    </div>
  );
}

/**
 * Two-column diff of one file: the text before the change on the left, the
 * text after it on the right, each line with its own line number. `cut` says
 * the hunks stop before the end of the change, and closes the list with a line
 * that tells the reader so.
 */
export function DiffSplit({ hunks, cut = false, className }: {
  hunks: FileChangeHunk[];
  cut?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const rows = useMemo(() => toSplitRows(hunks), [hunks]);

  if (rows.length === 0) return null;

  return (
    <div className={cn('overflow-hidden rounded-panel bg-code py-1 font-code text-mono', className)}>
      {rows.map((row, index) => (
        <div
          key={index}
          data-diff-pair
          data-diff-hunk-start={row.startsHunk ? '' : undefined}
          className={cn('grid grid-cols-2', row.startsHunk && 'border-t border-separator')}
        >
          <SideView side="before" cell={row.before} />
          <SideView side="after" cell={row.after} />
        </div>
      ))}
      {cut && (
        <div className="px-3 pt-1 font-sans text-caption text-label-tertiary">{t.chat.diffCut}</div>
      )}
    </div>
  );
}
