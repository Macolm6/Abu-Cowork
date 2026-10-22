// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getI18n, initLanguage } from '@/i18n';
import type { HttpFetchOutcome } from '@/types';
import { WebFetchStepView } from './WebFetchStepView';

const URL_TEXT = 'https://example.com/docs/api';

/** The result http_fetch returns: the status line, a blank line and the page body. */
function fetchResult(status: number, statusText: string, body: string, truncated = false): { text: string; outcome: HttpFetchOutcome } {
  const statusLine = `HTTP ${status} ${statusText}\n\n`;
  return {
    text: `${statusLine}${body}`,
    outcome: { status, statusText, body: [statusLine.length, statusLine.length + body.length], truncated },
  };
}

function statusLine(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-http-status-line]');
}

describe('WebFetchStepView', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the status line and the body', () => {
    const { text, outcome } = fetchResult(200, 'OK', '<h1>Docs</h1>\n<p>API</p>');
    const { container } = render(<WebFetchStepView url={URL_TEXT} status="completed" outcome={outcome} text={text} />);
    expect(screen.getByText('200 OK')).toBeInTheDocument();
    expect(statusLine(container)).not.toHaveTextContent(getI18n().task.webBodyTruncated);
    expect(screen.getByText(/<p>API<\/p>/)).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 200/)).not.toBeInTheDocument();
  });

  it('says the content was truncated on the status line', () => {
    const { text, outcome } = fetchResult(200, 'OK', 'start of page', true);
    const { container } = render(<WebFetchStepView url={URL_TEXT} status="completed" outcome={outcome} text={text} />);
    const line = statusLine(container);
    expect(line).toHaveTextContent('200 OK');
    expect(line).toHaveTextContent(getI18n().task.webBodyTruncated);
  });

  it('shows the number alone for an empty status text', () => {
    const { text, outcome } = fetchResult(404, '', 'missing');
    const { container } = render(<WebFetchStepView url={URL_TEXT} status="completed" outcome={outcome} text={text} />);
    expect(statusLine(container)?.textContent).toBe('404');
  });

  it('links the address', () => {
    const { container } = render(<WebFetchStepView url={URL_TEXT} status="running" outcome={undefined} text="" />);
    const link = container.querySelector(`a[href="${URL_TEXT}"][target="_blank"]`);
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent(URL_TEXT);
    expect(container.querySelector('[data-tool-result]')).toBeNull();
  });

  it('shows the whole text without a record', () => {
    const text = 'HTTP 500 Internal Server Error\n\nboom';
    const { container } = render(<WebFetchStepView url={URL_TEXT} status="completed" outcome={undefined} text={text} />);
    expect(statusLine(container)).toBeNull();
    const result = container.querySelector('[data-tool-result]');
    expect(result).toHaveTextContent('HTTP 500 Internal Server Error');
    expect(result).toHaveTextContent('boom');
  });
});
