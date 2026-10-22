import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentLoop } from '@/core/agent/agentLoop';
import { getChatDelta, setChatDelta } from '@/core/agent/ports/chatDelta';
import { getConversationReader, setConversationReader } from '@/core/agent/ports/conversationReader';
import { getToolInvoker, setToolInvoker, type ToolInvoker } from '@/core/agent/ports/toolInvoker';
import * as adapters from '@/core/llm/selectChatAdapter';
import { createCompactBoundaryMarker } from '@/core/context/compactBoundary';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Conversation, Message, StreamEvent, ToolDefinition } from '@/types';
import { createConversationRunMirror } from './conversationRunMirror';
import { createFrameChatDelta } from './portFrameSenders';

// The run's topology inside the sidecar: the loop WRITES through a frame
// ChatDelta whose `onLocalApply` is the run mirror, and READS the conversation
// back from that same mirror. These tests wire the real loop to exactly that
// pair and count the summarisation calls the provider receives.

const TOOL_TURNS = 5;
const ROUND_TEXT = 'The quarterly report covers revenue, churn and the hiring plan in detail. '.repeat(260);

function seededMessages(userMessageId: string): Message[] {
  const messages: Message[] = [];
  for (let round = 0; round < 8; round++) {
    messages.push({ id: `u${round}`, role: 'user', content: `question ${round} ${ROUND_TEXT}`, timestamp: round * 2 });
    messages.push({ id: `a${round}`, role: 'assistant', content: `answer ${round} ${ROUND_TEXT}`, timestamp: round * 2 + 1 });
  }
  messages.push({ id: userMessageId, role: 'user', content: 'continue the analysis', timestamp: 100 });
  return messages;
}

function isSummarisationCall(messages: unknown): boolean {
  return Array.isArray(messages) && (messages[0] as Message | undefined)?.id === 'compress-prompt';
}

interface SidecarRunHarness {
  summarisationCalls: () => number;
  providerTurns: () => number;
  mirroredConversation: () => Conversation | undefined;
  run: () => Promise<{ reason: string }>;
}

function createSidecarRunHarness(extraSeed: Message[] = []): SidecarRunHarness {
  const settings = useSettingsStore.getState();
  useSettingsStore.setState({
    activeModel: { providerId: 'ollama', modelId: 'llama3.2' },
    contextWindowSize: 60_000,
    maxOutputTokens: 4_000,
    providers: settings.providers.map((p) =>
      p.id === 'ollama'
        ? { ...p, enabled: true, models: p.models.some((m) => m.id === 'llama3.2') ? p.models : [...p.models, { id: 'llama3.2', label: 'llama3.2' }] }
        : p),
  });

  const conversationId = 'conv-context-cache';
  const userMessageId = 'msg-current';
  const seedMessages = seededMessages(userMessageId);
  seedMessages.splice(seedMessages.length - 1, 0, ...extraSeed);
  const conversation: Conversation = {
    id: conversationId,
    title: 'T',
    messages: seedMessages,
    createdAt: 0,
    updatedAt: 0,
    status: 'idle',
  } as Conversation;

  const mirror = createConversationRunMirror(conversationId, { conversation });
  setConversationReader(mirror.reader);
  setChatDelta(createFrameChatDelta(() => undefined, mirror.applyChatDeltaWrite));

  let summarisationCalls = 0;
  let providerTurns = 0;
  const chat = vi.fn(async (messages: unknown, _options: unknown, onEvent: (event: StreamEvent) => void) => {
    if (isSummarisationCall(messages)) {
      summarisationCalls++;
      onEvent({ type: 'text', text: 'summary of the earlier rounds' });
      onEvent({ type: 'done', stopReason: 'end_turn' });
      return;
    }
    providerTurns++;
    if (providerTurns <= TOOL_TURNS) {
      onEvent({ type: 'tool_use', id: `call-${providerTurns}`, name: 'read_file', input: { path: `/w/${providerTurns}.md` } });
      onEvent({ type: 'done', stopReason: 'tool_use' });
      return;
    }
    onEvent({ type: 'text', text: 'done' });
    onEvent({ type: 'done', stopReason: 'end_turn' });
  });
  vi.spyOn(adapters, 'selectChatAdapter').mockReturnValue({ chat });

  const tools: ToolDefinition[] = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} }, execute: async () => 'ok' }];
  const invoker: ToolInvoker = {
    getAllTools: () => tools,
    toolResultToString: String,
    executeAnyTool: vi.fn(async () => 'file body'),
  };
  setToolInvoker(invoker);

  return {
    summarisationCalls: () => summarisationCalls,
    providerTurns: () => providerTurns,
    mirroredConversation: () => mirror.reader.getConversation(conversationId),
    run: () => runAgentLoop(conversationId, 'continue the analysis', {
      orchestration: { route: { type: 'general', name: 'abu', cleanInput: 'continue the analysis' }, systemPromptSections: [] },
      prePersistedUserMessageId: userMessageId,
    }),
  };
}

describe('sidecar run · ephemeral context cache', () => {
  const originalReader = getConversationReader();
  const originalDelta = getChatDelta();
  const originalInvoker = getToolInvoker();
  const originalSettings = useSettingsStore.getState();

  afterEach(() => {
    setConversationReader(originalReader);
    setChatDelta(originalDelta);
    setToolInvoker(originalInvoker);
    useSettingsStore.setState({
      activeModel: originalSettings.activeModel,
      providers: originalSettings.providers,
      contextWindowSize: originalSettings.contextWindowSize,
      maxOutputTokens: originalSettings.maxOutputTokens,
    });
    useChatStore.setState({ conversations: {} });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('summarises once and reuses the summary on the following iterations of the same run', async () => {
    const harness = createSidecarRunHarness();

    const result = await harness.run();

    expect(result.reason).toBe('completed');
    expect(harness.providerTurns()).toBe(TOOL_TURNS + 1);
    expect(harness.summarisationCalls()).toBe(1);
    expect(harness.mirroredConversation()?.contextCache?.summaryMessage.id).toMatch(/^context-summary-/);
  });

  it('leaves the ephemeral path untouched when a compact-boundary marker already covers the history', async () => {
    const marker = createCompactBoundaryMarker({
      summaryText: 'persistent summary',
      summarizedFromId: 'u1',
      summarizedToId: 'a4',
      source: 'auto',
      timestamp: 50,
    });
    const harness = createSidecarRunHarness([marker]);

    const result = await harness.run();

    expect(result.reason).toBe('completed');
    expect(harness.summarisationCalls()).toBe(0);
    expect(harness.mirroredConversation()?.contextCache).toBeUndefined();
  });
});
