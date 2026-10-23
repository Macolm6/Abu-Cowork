// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import type { ReactElement } from 'react';
import { cleanup, render as renderBare, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { ToolCall } from '@/types';
import { StepToolView } from './StepToolView';
import { TOOL_VIEW_NAMES, collectToolViewRecords, hasToolView } from './toolViewRecords';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const VIEWS: Array<[string, string, Record<string, unknown>]> = [
  [TOOL_NAMES.RUN_COMMAND, 'command', { command: 'ls' }],
  [TOOL_NAMES.READ_FILE, 'file-read', { path: '/work/a.ts' }],
  [TOOL_NAMES.SEARCH_FILES, 'search', { pattern: 'useEffect', path: '/work' }],
  [TOOL_NAMES.FIND_FILES, 'find', { pattern: '*.ts', path: '/work' }],
  [TOOL_NAMES.LIST_DIRECTORY, 'list', { path: '/work' }],
  [TOOL_NAMES.HTTP_FETCH, 'web-fetch', { url: 'https://example.com' }],
  [TOOL_NAMES.WEB_SEARCH, 'web-search', { query: 'abu' }],
];

describe('StepToolView', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
  });

  it.each(VIEWS)('picks the %s view', (toolName, view, input) => {
    const { container } = render(
      <StepToolView toolName={toolName} status="completed" input={input} record={undefined} text="done" fullUnavailable={false} />,
    );
    expect(container.querySelector(`[data-step-view="${view}"]`)).not.toBeNull();
    expect(container.querySelectorAll('[data-step-view]')).toHaveLength(1);
    expect(hasToolView(toolName)).toBe(true);
  });

  it('knows the seven tools that have a view', () => {
    expect([...TOOL_VIEW_NAMES].sort()).toEqual(VIEWS.map(([name]) => name).sort());
    expect(hasToolView('bash')).toBe(false);
    expect(hasToolView(undefined)).toBe(false);
    expect(hasToolView('run_command')).toBe(true);
  });

  it('shows only the failure text for an error step', () => {
    const t = getI18n();
    const { container } = render(
      <StepToolView
        toolName={TOOL_NAMES.HTTP_FETCH}
        status="error"
        input={{ url: 'https://example.com' }}
        record={{ input: { url: 'https://example.com' }, httpFetchOutcome: { status: 500, statusText: 'x', body: [0, 0], truncated: false } }}
        text="no such file"
        fullUnavailable={false}
      />,
    );
    const failure = screen.getByText('no such file');
    expect(failure.closest('.text-danger')).not.toBeNull();
    expect(container.querySelector('[data-http-status-line]')).toBeNull();
    expect(screen.queryByText(t.task.output)).not.toBeInTheDocument();
    expect(screen.queryByText('https://example.com')).not.toBeInTheDocument();
  });

  it('says the whole result is not in the conversation', () => {
    render(
      <StepToolView toolName={TOOL_NAMES.READ_FILE} status="completed" input={{ path: '/work/a.ts' }} record={undefined} text="part" fullUnavailable />,
    );
    expect(screen.getByText('这段对话里没有这一步的完整结果')).toBeInTheDocument();
  });

  it('reads the subject from the input and the record from the record', () => {
    const t = getI18n();
    render(
      <StepToolView
        toolName={TOOL_NAMES.RUN_COMMAND}
        status="completed"
        input={{ command: 'npm test' }}
        record={{ input: { command: 'npm test' }, commandOutcome: { exitCode: 1, stderr: [8, 12] } }}
        text={'stderr:\nfail\n\nexit code: 1'}
        fullUnavailable={false}
      />,
    );
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText(t.task.errorOutput)).toBeInTheDocument();
  });

  it("collects records of the turn's own calls only", () => {
    const calls: ToolCall[] = [
      { id: 'a', name: TOOL_NAMES.RUN_COMMAND, input: { command: 'ls' }, commandOutcome: { exitCode: 0 } },
      { id: 'b', name: TOOL_NAMES.READ_FILE, input: { _durableTruncated: true }, fileReadOutcome: { kind: 'document' } },
      {
        id: 'c',
        name: TOOL_NAMES.HTTP_FETCH,
        input: { url: 'https://example.com' },
        httpFetchOutcome: { status: 200, statusText: 'OK', body: [17, 20], truncated: false },
      },
      { id: 'd', name: TOOL_NAMES.RUN_COMMAND, input: { command: 'pwd' }, commandOutcome: { exitCode: 0 }, fromSubagent: true },
    ];
    const records = collectToolViewRecords(calls);
    expect([...records.keys()]).toEqual(['a', 'b', 'c']);
    expect(records.get('a')).toEqual({ input: { command: 'ls' }, commandOutcome: { exitCode: 0 } });
    expect(records.get('b')).toEqual({ input: {}, fileReadOutcome: { kind: 'document' } });
    expect(records.get('c')).toEqual({
      input: { url: 'https://example.com' },
      httpFetchOutcome: { status: 200, statusText: 'OK', body: [17, 20], truncated: false },
    });
  });
});
