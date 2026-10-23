import { useMemo } from 'react';
import { Link } from '@/components/ds/link';
import { useI18n } from '@/i18n';
import type { HttpFetchOutcome } from '@/types';
import { foldResultRows } from '@/utils/toolResultFold';
import { webFetchView } from '@/utils/toolViews/webFetchView';
import { ResultRows } from '@/components/chat/DetailBlockView';
import { FoldedRows } from './FoldedRows';
import type { StepViewStatus } from './CommandStepView';

/** An http_fetch step: the address, then the response status and the page body. */
export function WebFetchStepView({ url, status, outcome, text }: {
  url: string;
  status: StepViewStatus;
  outcome: HttpFetchOutcome | undefined;
  text: string;
}) {
  const { t } = useI18n();
  const completed = status === 'completed';
  const view = useMemo(() => {
    if (!completed) return null;
    const fetched = webFetchView(text, outcome);
    return { status: fetched.status, truncated: fetched.truncated, body: foldResultRows(fetched.body) };
  }, [completed, text, outcome]);

  return (
    <div className="overflow-hidden rounded-panel bg-code">
      <div className="px-3 py-2">
        <Link href={url} target="_blank" rel="noopener noreferrer" className="break-all font-code text-mono">
          {url}
        </Link>
      </div>
      {view && (
        <div className="border-t border-separator">
          {view.status && (
            <div data-http-status-line className="flex flex-wrap gap-2 px-3 pt-2 text-caption text-label-secondary">
              <span>{`${view.status.code} ${view.status.text}`.trim()}</span>
              {view.truncated && <span className="text-label-tertiary">{t.task.webBodyTruncated}</span>}
            </div>
          )}
          <FoldedRows
            fold={view.body}
            renderRows={(rows) => <ResultRows rows={rows} t={t} />}
            className="text-label"
          />
        </div>
      )}
    </div>
  );
}
