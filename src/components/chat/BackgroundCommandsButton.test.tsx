// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render as renderBare, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DesignSystemProvider } from '@/components/ds/provider';
import {
  useBackgroundCommandStore,
  type BackgroundCommandRow,
} from '@/stores/backgroundCommandStore';
import BackgroundCommandsButton from './BackgroundCommandsButton';

// xterm draws on a canvas and measures fonts, which happy-dom cannot do. The stand-in works
// like xterm's write queue: a write is parsed later, in order, with its callback after it, and
// RIS (ESC c) clears the buffer when it is parsed; reset() clears it at once. `calls` is the
// order in which the buffer saw text and resets, `writes` the text it holds. `parseDelayMs`
// is how long the queue waits before parsing; `bufferLength` is the line count its buffer reports.
type TerminalCall = ['write', string] | ['reset'];
const terminals = vi.hoisted(() => ({
  instances: [] as { options: Record<string, unknown>; writes: string[]; calls: TerminalCall[]; disposed: boolean }[],
  bufferLength: 0,
  parseDelayMs: 0,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    rows = 24;
    writes: string[] = [];
    calls: TerminalCall[] = [];
    disposed = false;
    private queue: { data: string; callback?: () => void }[] = [];
    private parseScheduled = false;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      terminals.instances.push(this);
    }
    get buffer() { return { active: { length: terminals.bufferLength } }; }
    loadAddon() {}
    open() {}
    write(data: string, callback?: () => void) {
      this.queue.push({ data, callback });
      if (this.parseScheduled) return;
      this.parseScheduled = true;
      setTimeout(() => {
        this.parseScheduled = false;
        for (const { data: next, callback: done } of this.queue.splice(0)) {
          if (next === '\x1bc') this.reset();
          else {
            this.writes.push(next);
            this.calls.push(['write', next]);
          }
          done?.();
        }
      }, terminals.parseDelayMs);
    }
    reset() {
      this.writes = [];
      this.calls.push(['reset']);
    }
    selectAll() {}
    getSelection() { return this.writes.join(''); }
    clearSelection() {}
    dispose() { this.disposed = true; }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

const invokeMock = vi.mocked(invoke);
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const START = 1_760_000_000_000;

function row(id: string, partial: Partial<BackgroundCommandRow> = {}): BackgroundCommandRow {
  return {
    id,
    command: `npm run ${id}`,
    cwd: '/work',
    status: 'running',
    exitCode: null,
    startedAt: START,
    finishedAt: null,
    ...partial,
  };
}

function setRows(rows: BackgroundCommandRow[]) {
  act(() => {
    useBackgroundCommandStore.setState({ rows: { c1: rows } });
  });
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function openList(name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
  await flush();
  return screen.getByRole('dialog');
}

function outputCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'background_command_output');
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START + 192_000);
  terminals.instances.length = 0;
  terminals.bufferLength = 0;
  terminals.parseDelayMs = 0;
  invokeMock.mockReset();
  useBackgroundCommandStore.setState({ rows: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BackgroundCommandsButton', () => {
  it('renders nothing without background commands', () => {
    const { container, rerender } = render(<BackgroundCommandsButton conversationId="c1" />);
    expect(container).toBeEmptyDOMElement();

    setRows([]);
    rerender(<BackgroundCommandsButton conversationId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the running count', () => {
    setRows([
      row('a'),
      row('b'),
      row('c', { status: 'completed', exitCode: 0, finishedAt: START + 5_000 }),
    ]);
    render(<BackgroundCommandsButton conversationId="c1" />);
    expect(screen.getByRole('button', { name: '2 background commands running' })).toBeInTheDocument();

    setRows([
      row('a', { status: 'stopped', finishedAt: START + 1_000 }),
      row('b', { status: 'failed', exitCode: 1, finishedAt: START + 2_000 }),
      row('c', { status: 'completed', exitCode: 0, finishedAt: START + 5_000 }),
    ]);
    expect(screen.getByRole('button', { name: '3 background commands' })).toBeInTheDocument();
  });

  it('groups running rows before finished rows', async () => {
    setRows([
      row('done', { status: 'failed', exitCode: 2, finishedAt: START + 72_000 }),
      row('dev'),
      row('watch', { status: 'stopping' }),
      row('lint', { status: 'stopped', finishedAt: START + 3_000 }),
    ]);
    render(<BackgroundCommandsButton conversationId="c1" />);
    const list = await openList('2 background commands running');
    const text = list.textContent ?? '';

    const order = ['npm run dev', 'npm run watch', 'Finished 2', 'npm run done', 'npm run lint'].map((part) => text.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(within(list).getByText('Running')).toBeInTheDocument();
    expect(within(list).getByText('Stopping')).toBeInTheDocument();
    expect(within(list).getByText('Failed · exit 2')).toBeInTheDocument();
    expect(within(list).getByText('Stopped')).toBeInTheDocument();
    expect(within(list).getAllByText('3m 12s')).toHaveLength(2);
    expect(within(list).getByText('1m 12s')).toBeInTheDocument();
    expect(within(list).getByText('3s')).toBeInTheDocument();

    // A running row's time moves on while the list is open.
    await flush(1_000);
    expect(within(list).getAllByText('3m 13s')).toHaveLength(2);
  });

  it('stops after a second press within three seconds', async () => {
    invokeMock.mockResolvedValue('requested');
    setRows([row('dev')]);
    render(<BackgroundCommandsButton conversationId="c1" />);
    const list = await openList('1 background commands running');

    fireEvent.click(within(list).getByRole('button', { name: 'Stop' }));
    expect(within(list).getByRole('button', { name: 'Confirm stop' })).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith('background_command_stop', expect.anything());

    await flush(3_000);
    expect(within(list).queryByRole('button', { name: 'Confirm stop' })).not.toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith('background_command_stop', expect.anything());

    fireEvent.click(within(list).getByRole('button', { name: 'Stop' }));
    fireEvent.click(within(list).getByRole('button', { name: 'Confirm stop' }));
    await flush();
    const stops = invokeMock.mock.calls.filter(([command]) => command === 'background_command_stop');
    expect(stops).toEqual([['background_command_stop', { conversationId: 'c1', id: 'dev' }]]);

    // The button waits for the row to change; a further press sends nothing.
    fireEvent.click(within(list).getByRole('button', { name: 'Confirm stop' }));
    await flush(3_000);
    expect(invokeMock.mock.calls.filter(([command]) => command === 'background_command_stop')).toHaveLength(1);

    setRows([row('dev', { status: 'stopping' })]);
    expect(within(list).queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Confirm stop' })).not.toBeInTheDocument();
    expect(within(list).getByText('Stopping')).toBeInTheDocument();
  });

  it('shows stop failed for four seconds', async () => {
    invokeMock.mockRejectedValue(new Error('kill failed'));
    setRows([row('dev')]);
    render(<BackgroundCommandsButton conversationId="c1" />);
    const list = await openList('1 background commands running');

    fireEvent.click(within(list).getByRole('button', { name: 'Stop' }));
    fireEvent.click(within(list).getByRole('button', { name: 'Confirm stop' }));
    await flush();
    expect(within(list).getByText('Stop failed')).toBeInTheDocument();
    expect(within(list).getByText('Running')).toBeInTheDocument();
    // It can be tried again.
    expect(within(list).getByRole('button', { name: 'Stop' })).toBeInTheDocument();

    await flush(3_999);
    expect(within(list).getByText('Stop failed')).toBeInTheDocument();
    await flush(1);
    expect(within(list).queryByText('Stop failed')).not.toBeInTheDocument();
  });

  it('reads output only while a row is expanded', async () => {
    let written = 0;
    invokeMock.mockImplementation(async (command) => {
      if (command !== 'background_command_output') throw new Error(`unexpected ${command}`);
      const text = 'line\n';
      written += text.length;
      return { text, next: written, gap: written === text.length, status: 'running', exitCode: null };
    });
    setRows([row('dev')]);
    render(<BackgroundCommandsButton conversationId="c1" />);
    const list = await openList('1 background commands running');
    expect(outputCalls()).toHaveLength(0);

    fireEvent.click(within(list).getByRole('button', { name: /npm run dev/ }));
    await flush();
    expect(outputCalls()).toEqual([['background_command_output', { conversationId: 'c1', id: 'dev', since: 0 }]]);
    expect(within(list).getByText('Earlier output dropped')).toBeInTheDocument();

    await flush(500);
    await flush(500);
    expect(outputCalls().map(([, args]) => (args as { since: number }).since)).toEqual([0, 5, 10]);

    // Collapsing the row stops the reads.
    fireEvent.click(within(list).getByRole('button', { name: /npm run dev/ }));
    await flush(2_000);
    expect(outputCalls()).toHaveLength(3);
    expect(terminals.instances[0].disposed).toBe(true);

    // So does closing the list.
    fireEvent.click(within(list).getByRole('button', { name: /npm run dev/ }));
    await flush();
    expect(outputCalls()).toHaveLength(4);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' });
    await flush(2_000);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(outputCalls()).toHaveLength(4);
  });

  it('replaces the shown output after a gap', async () => {
    let reads = 0;
    invokeMock.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return { text: 'old\n', next: 4, gap: false, status: 'running', exitCode: null };
      return { text: 'recent\n', next: 2_000_000, gap: true, status: 'running', exitCode: null };
    });
    setRows([row('yes')]);
    render(<BackgroundCommandsButton conversationId="c1" />);
    const list = await openList('1 background commands running');

    fireEvent.click(within(list).getByRole('button', { name: /npm run yes/ }));
    await flush();
    expect(within(list).queryByText('Earlier output dropped')).not.toBeInTheDocument();

    await flush(500);
    expect(reads).toBe(2);
    // xterm parses the queued writes.
    await flush(10);
    expect(terminals.instances).toHaveLength(1);
    expect(terminals.instances[0].calls).toEqual([['write', 'old\n'], ['reset'], ['write', 'recent\n']]);
    expect(terminals.instances[0].writes).toEqual(['recent\n']);
    expect(within(list).getByText('Earlier output dropped')).toBeInTheDocument();
  });

  it('resets after the output xterm has not parsed yet', async () => {
    // xterm is still parsing the first answer when the gap arrives.
    terminals.parseDelayMs = 2_000;
    let reads = 0;
    invokeMock.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return { text: 'old\n', next: 4, gap: false, status: 'running', exitCode: null };
      if (reads === 2) return { text: 'recent\n', next: 2_000_000, gap: true, status: 'running', exitCode: null };
      return { text: '', next: 2_000_000, gap: false, status: 'running', exitCode: null };
    });
    setRows([row('yes')]);
    render(<BackgroundCommandsButton conversationId="c1" />);
    const list = await openList('1 background commands running');

    fireEvent.click(within(list).getByRole('button', { name: /npm run yes/ }));
    await flush();
    await flush(500);
    expect(reads).toBe(2);
    expect(terminals.instances[0].calls).toEqual([]);

    await flush(2_000);
    expect(terminals.instances[0].calls).toEqual([['write', 'old\n'], ['reset'], ['write', 'recent\n']]);
    expect(terminals.instances[0].writes).toEqual(['recent\n']);
  });

  it('shows the drop notice once the terminal drops its first lines', async () => {
    invokeMock.mockResolvedValue({ text: 'line\n', next: 5, gap: false, status: 'completed', exitCode: 0 });
    setRows([row('long', { status: 'completed', exitCode: 0, finishedAt: START + 1_000 })]);
    // The buffer holds the whole scrollback (10 000 lines) and a screen of 24 rows.
    terminals.bufferLength = 10_024;
    render(<BackgroundCommandsButton conversationId="c1" />);
    const list = await openList('1 background commands');

    fireEvent.click(within(list).getByRole('button', { name: /npm run long/ }));
    await flush();
    // xterm parses the write and runs its callback.
    await flush();
    expect(terminals.instances).toHaveLength(1);
    expect(within(list).getByText('Earlier output dropped')).toBeInTheDocument();
  });

  it('shows no output for a silent command', async () => {
    invokeMock.mockResolvedValue({ text: '', next: 0, gap: false, status: 'completed', exitCode: 0 });
    setRows([row('quiet', { status: 'completed', exitCode: 0, finishedAt: START + 1_000 })]);
    render(<BackgroundCommandsButton conversationId="c1" />);
    const list = await openList('1 background commands');

    fireEvent.click(within(list).getByRole('button', { name: /npm run quiet/ }));
    await flush();
    expect(within(list).getByText('(no output)')).toBeInTheDocument();
    expect(terminals.instances).toHaveLength(0);
    // A finished command has nothing more to read.
    await flush(2_000);
    expect(outputCalls()).toHaveLength(1);
  });

  it('expands one row at a time', async () => {
    invokeMock.mockResolvedValue({ text: 'x', next: 1, gap: false, status: 'running', exitCode: null });
    setRows([row('dev'), row('watch')]);
    render(<BackgroundCommandsButton conversationId="c1" />);
    const list = await openList('2 background commands running');

    const dev = within(list).getByRole('button', { name: /npm run dev/ });
    const watch = within(list).getByRole('button', { name: /npm run watch/ });
    fireEvent.click(dev);
    await flush();
    expect(dev).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(watch);
    await flush();
    expect(watch).toHaveAttribute('aria-expanded', 'true');
    expect(dev).toHaveAttribute('aria-expanded', 'false');

    invokeMock.mockClear();
    await flush(500);
    expect(outputCalls().map(([, args]) => (args as { id: string }).id)).toEqual(['watch']);
  });

  it('clears finished rows', async () => {
    invokeMock.mockResolvedValue(undefined);
    setRows([row('dev'), row('done', { status: 'completed', exitCode: 0, finishedAt: START + 1_000 })]);
    render(<BackgroundCommandsButton conversationId="c1" />);
    const list = await openList('1 background commands running');

    fireEvent.click(within(list).getByRole('button', { name: 'Clear' }));
    await flush();
    expect(invokeMock).toHaveBeenCalledWith('background_command_clear', { conversationId: 'c1' });
  });

  it('keeps the interface responsive with a large burst', async () => {
    const burst = 'x'.repeat(1024 * 1024);
    let reads = 0;
    invokeMock.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return { text: burst, next: burst.length, gap: true, status: 'running', exitCode: null };
      return { text: '', next: burst.length, gap: false, status: 'running', exitCode: null };
    });
    setRows([row('yes')]);
    render(<BackgroundCommandsButton conversationId="c1" />);
    const list = await openList('1 background commands running');

    fireEvent.click(within(list).getByRole('button', { name: /npm run yes/ }));
    await flush();
    await flush(500);
    expect(reads).toBe(2);
    expect(terminals.instances).toHaveLength(1);
    expect(terminals.instances[0].writes).toEqual([burst]);
    expect(terminals.instances[0].options).toMatchObject({ disableStdin: true, fontSize: 13 });
  });
});
