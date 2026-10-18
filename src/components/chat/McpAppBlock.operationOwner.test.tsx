// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { setToolAuthorizationProvider, type OperationAuthorizationDecision, type ToolOperationRequest } from '@/core/tools/operationAuthorization';
import type { AppBridgeHandlers } from '@/core/mcp/appBridgeHandlers';
import type { ToolDefinition } from '@/types';
import McpAppBlock, { resetMcpAppSlots } from './McpAppBlock';

const definition: ToolDefinition = {
  name: 'weather__search', description: 'Search',
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Query' } } },
  execute: async () => 'unused',
};

function operationBoundary() {
  let current = true;
  let request: ToolOperationRequest | undefined;
  let release: ((decision: OperationAuthorizationDecision) => void) | undefined;
  const listeners = new Set<() => void>();
  const owner = {
    isCurrent: () => current,
    onInvalidated: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const allow = { decision: 'allow' } as const;
  setToolAuthorizationProvider({
    captureOwner: () => owner,
    begin: received => {
      request = received;
      return {
        inspect: () => allow,
        authorize: () => new Promise<OperationAuthorizationDecision>(resolve => {
          const cancel = () => resolve({ decision: 'deny', reason: 'Operation cancelled', denialKind: 'context-changed' });
          received.abortSignal?.addEventListener('abort', cancel, { once: true });
          release = decision => { received.abortSignal?.removeEventListener('abort', cancel); resolve(decision); };
          if (received.abortSignal?.aborted) cancel();
        }),
        authorizeFile: async () => allow,
        validate: () => current ? allow : { decision: 'deny', reason: 'Operation owner changed', denialKind: 'context-changed' },
      };
    },
  });
  return {
    get request() { return request; }, listeners,
    waiting: () => typeof release === 'function',
    allow: () => { release?.(allow); },
    invalidate: () => { current = false; for (const listener of listeners) listener(); },
  };
}

function mountBlock() {
  const sink: { handlers?: Partial<AppBridgeHandlers> } = {};
  const callTool = vi.fn(async () => 'result');
  const view = render(<McpAppBlock toolCallId="operation-test" server="weather" resourceUri="ui://weather/view.html"
    input={{}} result="ready" conversationId="conversation-test" deps={{
      readResource: async () => ({ mimeType: 'text/html;profile=mcp-app', text: '<p>ready</p>', isMcpApp: true }),
      isConnected: () => true, handshakeTimeoutMs: 0, isDark: () => false, findTool: () => definition, callTool,
      createSession: options => {
        sink.handlers = options.handlers;
        return { bridge: {} as never, isInitialized: () => true, whenInitialized: async () => true,
          sendToolInput: async () => {}, sendToolResult: async () => {}, sendToolCancelled: async () => {},
          sendHostContextChange: async () => {}, teardown: async () => {} };
      },
    }} />, { wrapper: DesignSystemProvider });
  return { sink, callTool, view };
}

async function begin(sink: { handlers?: Partial<AppBridgeHandlers> }, boundary: ReturnType<typeof operationBoundary>) {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(sink.handlers).toBeDefined();
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = sink.handlers!.oncalltool!({ name: 'search', arguments: { query: 'x'.repeat(300) } });
    pending.catch(() => {});
    await vi.waitFor(() => { expect(boundary.waiting()).toBe(true); });
  });
  return { pending };
}

beforeEach(() => { vi.useFakeTimers(); initLanguage('en-US'); resetMcpAppSlots(); });
afterEach(() => { cleanup(); vi.runOnlyPendingTimers(); vi.useRealTimers(); setToolAuthorizationProvider(null); resetMcpAppSlots(); });

describe('MCP App operation lifecycle through the real shared approval gate', () => {
  it('cancels waiting authorization when its iframe is removed and releases the owner listener', async () => {
    const boundary = operationBoundary();
    const { sink, callTool, view } = mountBlock();
    const { pending } = await begin(sink, boundary);
    expect(boundary.request?.input.query).toHaveLength(300);
    expect(boundary.request?.owner).toBeDefined();
    expect(boundary.listeners.size).toBe(1);
    await act(async () => { view.unmount(); });
    await expect(pending).rejects.toThrow('cancelled');
    expect(boundary.request?.abortSignal?.aborted).toBe(true);
    expect(boundary.listeners.size).toBe(0);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('cancels waiting authorization when the original operation owner changes', async () => {
    const boundary = operationBoundary();
    const { sink, callTool } = mountBlock();
    const { pending } = await begin(sink, boundary);
    await act(async () => { boundary.invalidate(); });
    await expect(pending).rejects.toThrow('cancelled');
    expect(boundary.request?.abortSignal?.aborted).toBe(true);
    expect(boundary.listeners.size).toBe(0);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('executes an approved operation once and releases its owner listener', async () => {
    const boundary = operationBoundary();
    const { sink, callTool } = mountBlock();
    const { pending } = await begin(sink, boundary);
    await act(async () => { boundary.allow(); await pending; });
    expect(callTool).toHaveBeenCalledWith('weather', 'search', { query: 'x'.repeat(300) });
    expect(callTool).toHaveBeenCalledOnce();
    expect(boundary.listeners.size).toBe(0);
  });
});
