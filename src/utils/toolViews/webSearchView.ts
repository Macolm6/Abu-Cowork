import { parseSearchResults } from '@/utils/searchParser';

export interface WebSearchEntry { title: string; url: string; snippet: string }

/** One result as the readable text of web_search writes it (`webTools.ts`). */
const RESULT_TEXT = /^\d+\. \*\*(.+)\*\* — .*\n\s+(.*)\n\s+🔗 (\S+)$/gm;

/** The results of a web_search step, from its JSON marker, else from its readable text. */
export function webSearchEntries(text: string): WebSearchEntry[] {
  const results = parseSearchResults(text);
  if (results && results.length > 0) {
    return results.map(({ title, url, snippet }) => ({ title, url, snippet }));
  }
  return Array.from(text.matchAll(RESULT_TEXT), (match) => ({ title: match[1], url: match[3], snippet: match[2] }));
}
