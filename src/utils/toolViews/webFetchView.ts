import type { HttpFetchOutcome } from '@/types';
import { toResultRows, type ToolResultRow } from '@/utils/toolResultFold';

export interface WebFetchView {
  status: { code: number; text: string } | null;
  truncated: boolean;
  body: ToolResultRow[];
}

/** An http_fetch result as its status and page body, read by the record http_fetch made. */
export function webFetchView(text: string, outcome: HttpFetchOutcome | undefined): WebFetchView {
  if (!outcome) return { status: null, truncated: false, body: toResultRows(text) };
  const [start, end] = outcome.body;
  return {
    status: { code: outcome.status, text: outcome.statusText },
    truncated: outcome.truncated,
    body: toResultRows(text.slice(Math.min(start, text.length), Math.min(end, text.length))),
  };
}
