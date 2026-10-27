// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignSystemProvider } from '@/components/ds/provider';
import CompactDivider from './CompactDivider';
import type { Message } from '@/types';

function makeMarker(source: 'auto' | 'manual', summaryText = '- keep the API stable'): Message {
  return {
    id: 'compact-boundary-test',
    role: 'system',
    content: '',
    timestamp: 0,
    compactBoundary: {
      summaryText,
      summarizedFromId: 'm1',
      summarizedToId: 'm2',
      createdAt: 0,
      source,
    },
  };
}

function renderDivider(message: Message, expanded: boolean, onToggle = vi.fn()) {
  render(<CompactDivider message={message} expanded={expanded} onToggle={onToggle} />, { wrapper: DesignSystemProvider });
  return onToggle;
}

describe('CompactDivider', () => {
  afterEach(() => cleanup());

  it('expands the summary as markdown when toggled', async () => {
    const user = userEvent.setup();
    const onToggle = renderDivider(makeMarker('auto'), true);
    const item = screen.getByText('keep the API stable');
    expect(item.tagName).toBe('LI');
    const row = screen.getByRole('button', { name: /Earlier content organized/ });
    expect(row).toHaveAttribute('aria-expanded', 'true');
    await user.click(row);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders collapsed without the summary', () => {
    renderDivider(makeMarker('auto'), false);
    expect(screen.queryByText('keep the API stable')).toBeNull();
    expect(screen.getByRole('button', { name: /Earlier content organized/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders a plain divider when the summary is empty', () => {
    renderDivider(makeMarker('auto', '   '), false);
    expect(screen.queryByRole('button', { name: /Earlier content organized/ })).toBeNull();
    expect(screen.getByText('Earlier content organized')).toBeVisible();
    expect(screen.getByText('No summary')).toBeVisible();
  });

  it('keeps the manual title', () => {
    renderDivider(makeMarker('manual'), false);
    expect(screen.getByText('Earlier content organized (manual)')).toBeInTheDocument();
  });

  it('shows progress with one spinner and no summary control', () => {
    render(<CompactDivider message={makeMarker('auto')} pending expanded={false} onToggle={vi.fn()} />, { wrapper: DesignSystemProvider });
    expect(screen.getByRole('status')).toHaveTextContent('Organizing earlier content');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('No summary')).toBeNull();
  });

  it('shows a failed summary request without a summary control', () => {
    const message = makeMarker('auto');
    message.compactBoundary!.status = 'failed';
    renderDivider(message, true);
    expect(screen.getByText('Earlier content could not be organized')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('keep the API stable')).toBeNull();
  });

  it('copies the summary', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      // userEvent installs its own clipboard; replace it after setup
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
      renderDivider(makeMarker('auto'), true);
      await user.click(screen.getByRole('button', { name: 'Copy' }));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('- keep the API stable');
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
      const words = screen.getAllByText('Copied').filter((el) => !el.closest('[role="tooltip"]'));
      expect(words).toHaveLength(1);
      expect(words[0].tagName).toBe('SPAN');
      expect(words[0]).toHaveClass('text-caption');
      await act(async () => { vi.advanceTimersByTime(2000); });
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
      expect(screen.queryAllByText('Copied').filter((el) => !el.closest('[role="tooltip"]'))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
