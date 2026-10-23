// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLanguage } from '@/i18n';
import type { SearchResult } from '@/types';
import { WebSearchStepView } from './WebSearchStepView';

const RESULTS: SearchResult[] = Array.from({ length: 8 }, (_, index) => ({
  title: `Result ${index}`,
  url: `https://example.com/page-${index}`,
  snippet: `Snippet ${index}`,
  source: 'example.com',
}));

/** The text web_search returns: the JSON marker, then the readable lines. */
function searchText(results: SearchResult[]): string {
  const lines = results
    .map((r, i) => `${i + 1}. **${r.title}** — ${r.source ?? ''}\n   ${r.snippet}\n   🔗 ${r.url}`)
    .join('\n\n');
  return `<!--SEARCH_JSON:${JSON.stringify(results)}-->\n\nSearch results (${results.length} total):\n\n${lines}`;
}

describe('WebSearchStepView', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
  });

  it('lists every entry with a title link, the address and the snippet', () => {
    const { container } = render(<WebSearchStepView query="abu desktop" status="completed" text={searchText(RESULTS)} />);
    expect(screen.getByText('abu desktop')).toBeInTheDocument();
    const links = Array.from(container.querySelectorAll('a[target="_blank"]'));
    expect(links).toHaveLength(8);
    links.forEach((link, index) => {
      expect(link).toHaveAttribute('href', RESULTS[index].url);
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveTextContent(RESULTS[index].title);
    });
    for (const result of RESULTS) {
      expect(screen.getByText(result.url)).toBeInTheDocument();
      expect(screen.getByText(result.snippet)).toBeInTheDocument();
    }
  });

  it('falls back to the text when there are no entries', () => {
    const text = 'No search results found for "abu".';
    const { container } = render(<WebSearchStepView query="abu" status="completed" text={text} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(container.querySelector('a')).toBeNull();
  });

  it('shows only the query while running', () => {
    const { container } = render(<WebSearchStepView query="abu" status="running" text="" />);
    expect(container.textContent).toBe('abu');
  });
});
