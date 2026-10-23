import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ds/button';
import { useI18n, format } from '@/i18n';
import type { RowFold } from '@/utils/toolResultFold';

export interface FoldedRowsProps<T> {
  fold: RowFold<T>;
  /** Rows of the start, the end, or everything when the button was pressed. */
  renderRows: (rows: readonly T[]) => ReactNode;
  /** Everything once the button was pressed; renderRows(fold.rows) when absent. */
  renderAll?: (rows: readonly T[]) => ReactNode;
  className?: string;
}

/** Folded rows: their start and end until the button shows all of them. */
export function FoldedRows<T>({ fold, renderRows, renderAll, className }: FoldedRowsProps<T>) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const folded = fold.hidden !== null && !showAll;
  return (
    <div data-tool-result className={cn('max-h-[300px] overflow-y-auto px-3 py-2', className)}>
      {folded ? renderRows(fold.head) : (renderAll ?? renderRows)(fold.rows)}
      {folded && fold.hidden && (
        <div className="py-1">
          <Button variant="plain" size="sm" onClick={() => setShowAll(true)}>
            {format(
              fold.hidden.unit === 'lines' ? t.chat.toolResultShowAllLines : t.chat.toolResultShowAllChars,
              { count: fold.hidden.count },
            )}
          </Button>
        </div>
      )}
      {folded && renderRows(fold.tail)}
    </div>
  );
}
