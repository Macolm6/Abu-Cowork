// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useMCPStore, type MCPServerEntry } from '@/stores/mcpStore';
import type { Conversation, ToolCall } from '@/types';
import ContextSection from './ContextSection';

// The section starts the MCP sync when it mounts; the test seeds the store itself.
vi.mock('@/stores/mcpStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/mcpStore')>();
  return { ...actual, initMCPStoreSync: vi.fn() };
});

const pressableRenders = vi.hoisted(() => vi.fn());

// Every render of the section renders its title button: this counts the section's renders.
vi.mock('@/components/ds/pressable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/pressable')>();
  return {
    ...actual,
    Pressable: (props: ComponentProps<typeof actual.Pressable>) => {
      pressableRenders();
      return actual.Pressable(props);
    },
  };
});

const CONV = 'conv-context';

function server(name: string, status: MCPServerEntry['status'], toolCount = 0): MCPServerEntry {
  return {
    config: { name },
    status,
    tools: Array.from({ length: toolCount }, (_, i) => ({ name: `tool-${i}` })),
  } as MCPServerEntry;
}

function seed({ loading }: { loading: boolean }) {
  const toolCalls: ToolCall[] = [
    { id: 't1', name: 'read_file', input: { path: '/work/notes.md' }, result: '# Notes\nfirst line' },
    { id: 't2', name: 'write_file', input: { path: '/work/main.ts' }, result: 'ok' },
    { id: 't3', name: 'github__search', input: {}, result: 'ok' },
    { id: 't4', name: 'slack__post', input: {}, result: 'ok' },
    { id: 't5', name: 'jira__list', input: {}, result: 'ok' },
  ];
  const conversation = {
    id: CONV,
    title: 'Context',
    messages: [{ id: 'm1', role: 'assistant', content: 'Working', timestamp: 1, toolCalls }],
    createdAt: 1,
    updatedAt: 1,
    status: 'running',
  } as Conversation;
  useChatStore.setState({ activeConversationId: CONV, conversations: { [CONV]: conversation } });
  useMCPStore.setState({
    isLoading: loading,
    servers: {
      github: server('github', 'connected', 2),
      slack: server('slack', 'reconnecting'),
      jira: server('jira', 'disconnected'),
    },
  });
}

function openContext() {
  render(<ContextSection />);
  const title = screen.getByRole('button', { name: /Activity Log/ });
  expect(title).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(title);
  expect(title).toHaveAttribute('aria-expanded', 'true');
}

function connectorsArea(): HTMLElement {
  const area = screen.getByRole('button', { name: /Connectors/ }).parentElement;
  if (!area) throw new Error('connectors area not found');
  return area;
}

describe('ContextSection', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
    useMCPStore.setState({ isLoading: false, servers: {} });
  });

  it('shows one spinner with its sentence while the connectors refresh, and still icons on the rows', () => {
    seed({ loading: true });
    openContext();

    const area = connectorsArea();
    expect(area.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(within(area).getByRole('status')).toHaveTextContent('Refreshing...');
    expect(within(area).getByText('Refreshing...')).not.toHaveClass('sr-only');

    const reconnecting = within(area).getByText('slack').parentElement as HTMLElement;
    expect(reconnecting.querySelector('svg')).toBeInTheDocument();
    expect(reconnecting.querySelector('[data-ds-spinner]')).not.toBeInTheDocument();
    expect(reconnecting.querySelector('.animate-spin')).not.toBeInTheDocument();

    const disconnected = within(area).getByText('jira').parentElement as HTMLElement;
    expect(disconnected.querySelector('svg')).not.toBeInTheDocument();
    expect(within(area).getByText('2 tools')).toBeInTheDocument();
    expect(within(area).getByText('1/3')).toBeInTheDocument();
  });

  it('shows no spinner once the connectors are loaded', () => {
    seed({ loading: false });
    openContext();

    expect(connectorsArea().querySelector('[data-ds-spinner]')).not.toBeInTheDocument();
  });

  it('collapses the connectors from their own title button', () => {
    seed({ loading: false });
    openContext();
    const title = screen.getByRole('button', { name: /Connectors/ });
    expect(title).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(title);

    expect(title).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('slack')).not.toBeInTheDocument();
  });

  it('shows the tool use and the connectors, and no list of files', () => {
    seed({ loading: false });
    openContext();

    expect(screen.getByText('Tool Usage')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connectors/ })).toBeInTheDocument();
    expect(screen.queryByText('notes.md')).not.toBeInTheDocument();
    expect(screen.queryByText('main.ts')).not.toBeInTheDocument();
    expect(screen.queryByText(/first line/)).not.toBeInTheDocument();
  });

  it('says where the tools will be shown before any tool is used', () => {
    useChatStore.setState({
      activeConversationId: CONV,
      conversations: { [CONV]: { id: CONV, title: 'Context', messages: [], createdAt: 1, updatedAt: 1, status: 'idle' } },
    });
    openContext();

    expect(screen.getByText('Tools Abu uses will appear here')).toBeInTheDocument();
  });

  it('counts tool use in neutral tags', () => {
    seed({ loading: false });
    openContext();

    const tag = screen.getByText('Read');
    expect(tag).toHaveClass('bg-fill');
    expect(tag).toHaveTextContent('Readx1');
    expect(screen.getByText('5 ops')).toBeInTheDocument();
  });

  // Streamed text leaves every message's tool calls as they are, so the section does
  // not render again; a new tool call does, and the count follows.
  it('renders again for a new tool call, not for streamed text', () => {
    seed({ loading: false });
    openContext();
    const before = pressableRenders.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    const rewriteLastMessage = (change: (message: Conversation['messages'][number]) => Conversation['messages'][number]) => {
      act(() => {
        useChatStore.setState((state) => {
          const conversation = state.conversations[CONV];
          const messages = conversation.messages.slice();
          messages[messages.length - 1] = change(messages[messages.length - 1]);
          return { conversations: { ...state.conversations, [CONV]: { ...conversation, messages } } };
        });
      });
    };
    for (const content of ['a', 'ab', 'abc']) rewriteLastMessage((message) => ({ ...message, content }));

    expect(pressableRenders.mock.calls.length).toBe(before);

    rewriteLastMessage((message) => ({
      ...message,
      toolCalls: [...(message.toolCalls ?? []), { id: 't6', name: 'read_file', input: { path: '/work/extra.md' }, result: 'more' }],
    }));

    expect(screen.getByText('6 ops')).toBeInTheDocument();
    expect(screen.getByText('Read')).toHaveTextContent('Readx2');
  });
});
