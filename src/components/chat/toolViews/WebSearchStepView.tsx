import { useMemo } from 'react';
import { Link } from '@/components/ds/link';
import { useI18n } from '@/i18n';
import { toResultRows } from '@/utils/toolResultFold';
import { webSearchEntries } from '@/utils/toolViews/webSearchView';
import { ResultRows } from '@/components/chat/DetailBlockView';
import type { StepViewStatus } from './CommandStepView';

/** A web_search step: the query, then each result's title, address and snippet. */
export function WebSearchStepView({ query, status, text }: {
  query: string;
  status: StepViewStatus;
  text: string;
}) {
  const { t } = useI18n();
  const completed = status === 'completed';
  const entries = useMemo(() => (completed ? webSearchEntries(text) : null), [completed, text]);

  return (
    <div className="overflow-hidden rounded-panel bg-code">
      <div className="whitespace-pre-wrap break-all px-3 py-2 font-code text-mono text-label">{query}</div>
      {entries && (
        <div data-tool-result className="max-h-[300px] overflow-y-auto border-t border-separator px-3 py-2 text-label">
          {entries.length > 0 ? entries.map((entry, index) => (
            <div key={index} className="py-1">
              <Link href={entry.url} target="_blank" rel="noopener noreferrer" className="text-ui">
                {entry.title}
              </Link>
              <div className="break-all text-caption text-label-tertiary">{entry.url}</div>
              <div className="text-caption text-label-secondary">{entry.snippet}</div>
            </div>
          )) : (
            <ResultRows rows={toResultRows(text)} t={t} />
          )}
        </div>
      )}
    </div>
  );
}
