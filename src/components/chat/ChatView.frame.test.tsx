// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, render as renderBare, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import ChatView from './ChatView';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { getI18n } from '@/i18n';
import type { Message, SubagentDefinition } from '@/types';

interface MockVirtuosoProps {
  atBottomStateChange?: (atBottom: boolean) => void;
  data?: Message[][];
  itemContent?: (index: number, group: Message[]) => React.ReactNode;
  components?: { Footer?: React.ComponentType<{ context?: unknown }> };
  context?: unknown;
}

const harness = vi.hoisted(() => ({
  props: null as MockVirtuosoProps | null,
  scrollToIndex: vi.fn(),
  tooltipRenders: vi.fn(),
  teamLeader: null as null | Record<string, unknown>,
  macOS: false,
  // Rows the list has scrolled out of view: the stand-in unmounts them like Virtuoso does.
  unmountedRowIds: new Set<string>(),
  refreshList: null as null | (() => void),
}));

vi.mock('@/utils/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/platform')>();
  return { ...actual, isMacOS: () => harness.macOS };
});

vi.mock('@/core/agent/agentLoopRunner', () => ({ runAgentLoopDispatched: vi.fn() }));

vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  return {
    Virtuoso: React.forwardRef(function MockVirtuoso(props: MockVirtuosoProps, ref) {
      harness.props = props;
      const [, refresh] = React.useReducer((n: number) => n + 1, 0);
      harness.refreshList = refresh;
      React.useImperativeHandle(ref, () => ({ scrollToIndex: harness.scrollToIndex }));
      return React.createElement(
        'div',
        { 'data-testid': 'mock-virtuoso' },
        ...(props.data ?? []).map((group, index) => harness.unmountedRowIds.has(group[0]?.id) ? null : React.createElement(
          'div',
          { 'data-index': String(index), key: group[0]?.id ?? index },
          props.itemContent?.(index, group),
        )),
      );
    }),
  };
});

// The frame is under test; the message rows, the composer and the strips above it are not.
vi.mock('./MessageGroup', () => ({ default: () => null }));
vi.mock('./ChatInput', () => ({ default: () => null }));
vi.mock('./AgentStatusStrip', () => ({ default: () => null }));
vi.mock('./QueuedMessagesStrip', () => ({ default: () => null }));

vi.mock('@/core/usage/usageLedgerClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/usage/usageLedgerClient')>();
  return {
    ...actual,
    queryUsageConversation: vi.fn(async () => ({
      available: true,
      totals: { ...actual.emptyUsageAggregate(), attempts: 2, inputKnownSum: 1200, outputKnownSum: 300 },
    })),
  };
});

vi.mock('@/components/team/useConversationTeamLeader', () => ({
  useConversationTeamLeader: () => harness.teamLeader,
}));

// Counts every ds tooltip render in the frame: the chapter menu button, the usage chip and the copy button.
vi.mock('@/components/ds/tooltip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/tooltip')>();
  return {
    ...actual,
    Tooltip: (props: ComponentProps<typeof actual.Tooltip>) => {
      harness.tooltipRenders();
      return actual.Tooltip(props);
    },
  };
});

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

function message(id: string, role: Message['role'], content: string, loopId: string): Message {
  return { id, role, content, loopId, timestamp: 1 };
}

/** Three turns: enough chapters for the chapter menu (the rail does not fit a zero-width test scroller). */
function setupConversation(): string {
  const store = useChatStore.getState();
  const conversationId = store.createConversation();
  for (let turn = 1; turn <= 3; turn += 1) {
    store.addMessage(conversationId, message(`user-${turn}`, 'user', `prompt ${turn}`, `loop-${turn}`));
    store.addMessage(conversationId, message(`assistant-${turn}`, 'assistant', `answer ${turn}`, `loop-${turn}`));
  }
  store.setConversationStatus(conversationId, 'idle');
  return conversationId;
}

const COMPACT_SUMMARY = 'keep the API stable';

/** One earlier turn, then a compaction marker as its own row. */
function setupCompactedConversation(): { conversationId: string; markerId: string } {
  const store = useChatStore.getState();
  const conversationId = store.createConversation();
  const markerId = `compact-boundary-${conversationId}`;
  store.addMessage(conversationId, message('user-1', 'user', 'prompt 1', 'loop-1'));
  store.addMessage(conversationId, message('assistant-1', 'assistant', 'answer 1', 'loop-1'));
  store.addMessage(conversationId, {
    id: markerId,
    role: 'system',
    content: '',
    timestamp: 2,
    compactBoundary: {
      summaryText: COMPACT_SUMMARY,
      summarizedFromId: 'user-1',
      summarizedToId: 'assistant-1',
      createdAt: 2,
      source: 'auto',
    },
  });
  store.setConversationStatus(conversationId, 'idle');
  return { conversationId, markerId };
}

function compactRow() {
  return screen.getByRole('button', { name: /Context compacted/ });
}

function setupUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

describe('ChatView frame', () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    harness.props = null;
    harness.scrollToIndex.mockReset();
    harness.tooltipRenders.mockReset();
    harness.teamLeader = null;
    harness.macOS = false;
    harness.unmountedRowIds.clear();
    harness.refreshList = null;
    useChatStore.setState(useChatStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows one loading line while a task is read from disk', () => {
    useChatStore.setState({ activeConversationId: 'not-loaded-yet' });

    render(<ChatView />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading...');
    expect(document.querySelector('.animate-pulse')).toBeNull();
  });

  it('asks for a model on a flat card whose only filled button opens the model settings', async () => {
    const user = setupUser();
    useSettingsStore.setState((state) => ({
      providers: state.providers.filter((provider) => provider.id !== 'ollama' && provider.id !== 'lmstudio').map((provider) => ({ ...provider, apiKey: '' })),
    }));
    const openSystemSettings = vi.spyOn(useSettingsStore.getState(), 'openSystemSettings');

    render(<ChatView />);

    const button = screen.getByRole('button', { name: getI18n().chat.setupButton });
    expect(button).toHaveClass('bg-emphasis');
    const card = button.parentElement!;
    expect(card).toHaveClass('rounded-panel');
    expect(card).toHaveClass('bg-surface');
    expect(card).not.toHaveClass('shadow-float');
    await user.click(button);
    expect(openSystemSettings).toHaveBeenCalledWith('ai-services');
  });

  it('paints no background of its own around the messages and the composer', async () => {
    setupConversation();

    render(<ChatView />);
    await screen.findByTestId('mock-virtuoso');

    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    const composerArea = scroller.nextElementSibling as HTMLElement;
    for (const element of [scroller.parentElement!, scroller, composerArea]) {
      expect(element.className.split(' ').filter((name) => name.startsWith('bg-'))).toEqual([]);
    }
  });

  it('renames the task in a text field: Enter saves, Escape keeps the old title', async () => {
    const user = setupUser();
    const conversationId = setupConversation();
    const oldTitle = useChatStore.getState().conversations[conversationId].title;
    render(<ChatView />);

    await user.dblClick(screen.getByTitle(oldTitle));
    const field = screen.getByRole('textbox');
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, 'Quarterly review{Escape}');
    expect(useChatStore.getState().conversations[conversationId].title).toBe(oldTitle);

    await user.dblClick(screen.getByTitle(oldTitle));
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'Quarterly review{Enter}');
    expect(useChatStore.getState().conversations[conversationId].title).toBe('Quarterly review');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps the title row clear of the floating panel toggle on macOS', () => {
    harness.macOS = true;
    setupConversation();

    render(<ChatView rightPanelToggleVisible />);

    const header = document.querySelector<HTMLElement>('.overlay-scroll')!.parentElement!.firstElementChild!;
    expect(header).toHaveClass('pr-12');
    expect(header).toHaveClass('h-11');
  });

  it('leaves the macOS title row at its own padding while the panel toggle is hidden', () => {
    harness.macOS = true;
    setupConversation();

    render(<ChatView />);

    const header = document.querySelector<HTMLElement>('.overlay-scroll')!.parentElement!.firstElementChild!;
    expect(header).not.toHaveClass('pr-12');
  });

  it('shows the team as a tag with the leader in its hover text', () => {
    harness.teamLeader = {
      teamId: 'tm-data',
      teamName: 'Data squad',
      leaderName: 'Analyst',
      leader: { name: 'Analyst', description: '', filePath: '', systemPrompt: '' } as SubagentDefinition,
      teamAvatar: null,
    };
    setupConversation();

    render(<ChatView />);

    const badge = screen.getByTestId('chat-title-team-badge');
    expect(badge).toHaveAttribute('title', 'Analyst · Data squad');
    expect(badge).toHaveTextContent('Data squad');
    expect(badge.firstElementChild).toHaveClass('rounded-control');
  });

  it('offers an opaque button back to the latest message once the reader scrolls up', async () => {
    const user = setupUser();
    setupConversation();
    render(<ChatView />);
    await screen.findByTestId('mock-virtuoso');
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;

    act(() => scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -12 })));
    act(() => harness.props?.atBottomStateChange?.(false));

    const button = screen.getByRole('button', { name: 'Scroll to bottom' });
    const backing = button.parentElement!;
    expect(backing).toHaveClass('bg-raised');
    expect(backing).toHaveClass('shadow-float');
    const layers = [button, backing, backing.parentElement!];
    for (const element of layers) {
      expect(element.className).not.toMatch(/backdrop-/);
    }

    await user.click(button);
    expect(harness.scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end', behavior: 'smooth' });
  });

  it('keeps a compaction summary expanded after its row remounts', async () => {
    const user = setupUser();
    const { markerId } = setupCompactedConversation();
    render(<ChatView />);

    await user.click(compactRow());
    expect(await screen.findByText(COMPACT_SUMMARY)).toBeInTheDocument();

    act(() => {
      harness.unmountedRowIds.add(markerId);
      harness.refreshList?.();
    });
    expect(screen.queryByRole('button', { name: /Context compacted/ })).toBeNull();

    act(() => {
      harness.unmountedRowIds.delete(markerId);
      harness.refreshList?.();
    });
    expect(compactRow()).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText(COMPACT_SUMMARY)).toBeInTheDocument();
  });

  it('resets expanded summaries when the conversation changes', async () => {
    const user = setupUser();
    const { conversationId } = setupCompactedConversation();
    render(<ChatView />);

    await user.click(compactRow());
    expect(await screen.findByText(COMPACT_SUMMARY)).toBeInTheDocument();

    const otherId = setupConversation();
    act(() => useChatStore.setState({ activeConversationId: otherId }));
    expect(screen.queryByRole('button', { name: /Context compacted/ })).toBeNull();
    act(() => useChatStore.setState({ activeConversationId: conversationId }));

    expect(compactRow()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(COMPACT_SUMMARY)).toBeNull();
  });

  it('releases the bottom pin when a summary expands', async () => {
    const user = setupUser();
    setupCompactedConversation();
    render(<ChatView />);
    await screen.findByTestId('mock-virtuoso');

    await user.click(compactRow());
    act(() => harness.props?.atBottomStateChange?.(false));

    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeInTheDocument();
  });

  it('shows usage, the disclaimer and the task number with a copy button under the composer', async () => {
    const conversationId = setupConversation();
    render(<ChatView />);

    expect(await screen.findByText('1.5k')).toBeInTheDocument();
    expect(screen.getByText(`#${conversationId.slice(0, 8)}`)).toHaveClass('font-code');
    expect(screen.getByRole('button', { name: /copy conversation id/i })).toBeInTheDocument();
  });

  it('does not re-render the frame’s tooltips and the chapter menu while a reply streams', async () => {
    const conversationId = setupConversation();
    useChatStore.getState().setConversationStatus(conversationId, 'running');
    render(<ChatView />);
    await screen.findByText('1.5k');
    expect(screen.getByRole('button', { name: 'Conversation chapters' })).toBeInTheDocument();
    // Let the scroll-spy's first frame pick the current chapter before counting.
    await act(async () => { vi.advanceTimersByTime(50); });
    const settled = harness.tooltipRenders.mock.calls.length;
    expect(settled).toBeGreaterThan(0);

    // What a flushed token frame does to the store.
    for (const content of ['answer 3 more', 'answer 3 more and more', 'answer 3 more and more words']) {
      act(() => useChatStore.getState().setLastMessageContent(conversationId, content, 'assistant-3'));
    }

    expect(useChatStore.getState().conversations[conversationId].messages.at(-1)?.content).toBe('answer 3 more and more words');
    expect(harness.tooltipRenders).toHaveBeenCalledTimes(settled);
  });

  it('jumps to a chapter picked from the menu', async () => {
    const user = setupUser();
    setupConversation();
    render(<ChatView />);

    await user.click(screen.getByRole('button', { name: 'Conversation chapters' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'prompt 2' }));

    await waitFor(() => expect(harness.scrollToIndex).toHaveBeenCalledWith({ index: 1, align: 'start', behavior: 'auto' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  // AgentStatusStrip above the composer says why the model is slow; the list keeps 「思考中」.
  it('keeps the thinking words in the list while a retry runs', () => {
    const t = getI18n();
    const store = useChatStore.getState();
    const conversationId = store.createConversation();
    store.addMessage(conversationId, message('user-1', 'user', 'prompt 1', 'loop-1'));
    store.setConversationStatus(conversationId, 'running');
    store.setRetryInfo(conversationId, { attempt: 2, maxAttempts: 3, delayMs: 5000 });
    render(<ChatView />);

    const Footer = harness.props?.components?.Footer;
    expect(Footer).toBeDefined();
    const { container } = render(Footer ? <Footer context={harness.props?.context} /> : <div />);
    expect(container).toHaveTextContent(t.status.thinking);
    expect(container).not.toHaveTextContent(/retrying/i);
  });
});
