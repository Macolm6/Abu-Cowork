import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@/types';
import { webSearchEntries } from './webSearchView';

/** The readable lines web_search writes for each result. */
function resultLines(results: SearchResult[]): string {
  return results
    .map((r, i) => `${i + 1}. **${r.title}** — ${r.source ?? ''}\n   ${r.snippet}\n   🔗 ${r.url}`)
    .join('\n\n');
}

const RESULTS: SearchResult[] = Array.from({ length: 8 }, (_, index) => ({
  title: `Result ${index}`,
  url: `https://example.com/${index}`,
  snippet: `Snippet ${index}`,
  source: 'example.com',
}));

describe('webSearchEntries', () => {
  it('reads every entry from the marker', () => {
    const text = `<!--SEARCH_JSON:${JSON.stringify(RESULTS)}-->\n\nSearch results (8 total):\n\n${resultLines(RESULTS)}`;
    const entries = webSearchEntries(text);
    expect(entries).toHaveLength(8);
    expect(entries[0]).toEqual({ title: 'Result 0', url: 'https://example.com/0', snippet: 'Snippet 0' });
  });

  it('reads entries from the text when the marker is absent', () => {
    const text = `Search results (2 total):\n\n${resultLines(RESULTS.slice(0, 2))}`;
    expect(webSearchEntries(text)).toEqual([
      { title: 'Result 0', url: 'https://example.com/0', snippet: 'Snippet 0' },
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1' },
    ]);
  });

  it('gives nothing for plain text', () => {
    expect(webSearchEntries('No search results found for "abu".')).toEqual([]);
  });
});
