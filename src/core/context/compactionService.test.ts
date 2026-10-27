import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '@/types';
import type { ProviderInstance } from '@/types/provider';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { registerBuiltinTools } from '@/core/tools/builtins';
import { resolveEffectiveLlmCreds } from '@/core/enterprise/llm-resolver';
import { LLMError, type LLMAdapter } from '@/core/llm/adapter';
import { compactConversationManually } from './compactionService';
import { isCompactBoundary } from './compactBoundary';
import { computeInputBudget } from './contextManager';
import { estimateMessageTokens, estimateTokens, estimateToolSchemaTokens } from './tokenEstimator';

const mockChat = vi.fn<LLMAdapter['chat']>();

vi.mock('@/core/llm/claude', () => ({
  ClaudeAdapter: class { chat = (...args: Parameters<LLMAdapter['chat']>) => mockChat(...args); },
}));
vi.mock('@/core/llm/openai-compatible', () => ({
  OpenAICompatibleAdapter: class { chat = (...args: Parameters<LLMAdapter['chat']>) => mockChat(...args); },
}));
vi.mock('@/core/llm/ollama-native', () => ({
  OllamaNativeAdapter: class { chat = (...args: Parameters<LLMAdapter['chat']>) => mockChat(...args); },
}));
vi.mock('@/core/enterprise/llm-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/enterprise/llm-resolver')>();
  return { ...actual, resolveEffectiveLlmCreds: vi.fn(actual.resolveEffectiveLlmCreds) };
});

const CONV_ID = 'test-conv-123';
const initialSettings = useSettingsStore.getState();
const initialChat = useChatStore.getState();
const initialWorkspace = useWorkspaceStore.getState();

function provider(id: string): ProviderInstance {
  return {
    id, source: 'custom', name: id, enabled: true, apiFormat: 'openai-compatible',
    baseUrl: `https://${id}.example.net/v1`, apiKey: `sk-${id}`,
    models: [{ id: `${id}-model`, label: `${id}-model` }],
    status: 'verified', sortOrder: 1, userAdded: true,
  };
}

function buildRounds(count: number): Message[] {
  return Array.from({ length: count * 2 }, (_, index) => ({
    id: `message-${index}`, role: index % 2 === 0 ? 'user' : 'assistant',
    content: `content-${index}`, timestamp: index + 1,
  }));
}

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const conversation: Conversation = {
    id: CONV_ID, title: 'Task', messages: buildRounds(6), status: 'completed',
    createdAt: 1, updatedAt: 2, workspacePath: '/task/workspace', ...overrides,
  };
  useChatStore.setState({ conversations: { [CONV_ID]: conversation }, activeConversationId: CONV_ID });
  return conversation;
}

function storedConversation(): Conversation {
  return useChatStore.getState().conversations[CONV_ID];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T00:00:00Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0.123456);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockChat.mockReset().mockImplementation(async (_messages, _options, onEvent) => {
    onEvent({ type: 'text', text: 'A summary of the conversation.' });
    onEvent({ type: 'done', stopReason: 'end_turn' });
  });
  vi.mocked(resolveEffectiveLlmCreds).mockImplementation((apiKey, baseUrl) => ({ apiKey, baseUrl, forceOpenAiCompatible: false }));
  useSettingsStore.setState({
    ...initialSettings,
    providers: [provider('default'), provider('own')],
    activeModel: { providerId: 'default', modelId: 'default-model' },
    contextWindowSize: 200_000, maxOutputTokens: 4096, soulInitialized: false,
  });
  useChatStore.setState({ ...initialChat, conversations: {}, conversationIndex: {}, activeConversationId: null });
  useWorkspaceStore.setState({ ...initialWorkspace, currentPath: '/another/task' });
  registerBuiltinTools();
});

afterEach(() => {
  useSettingsStore.setState(initialSettings);
  useChatStore.setState(initialChat);
  useWorkspaceStore.setState(initialWorkspace);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('compactConversationManually', () => {
  it.each([CONV_ID, ''])('returns no-conversation when the conversation is absent: %s', async (id) => {
    expect(await compactConversationManually(id)).toEqual({ compacted: false, reason: 'no-conversation' });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it.each([0, 1])('returns too-few for %s rounds', async (rounds) => {
    seedConversation({ messages: buildRounds(rounds) });
    expect(await compactConversationManually(CONV_ID)).toEqual({ compacted: false, reason: 'too-few' });
    expect(mockChat).not.toHaveBeenCalled();
    expect(storedConversation().isCompressing).toBe(false);
  });

  it('compacts two rounds through the real summary request and records a manual divider', async () => {
    const conversation = seedConversation({ messages: buildRounds(2) });
    expect(await compactConversationManually(CONV_ID)).toEqual({ compacted: true, reason: 'ok' });
    const marker = storedConversation().messages.at(-1)!;
    expect(isCompactBoundary(marker)).toBe(true);
    expect(marker.loopId).toBeUndefined();
    expect(marker.compactBoundary).toMatchObject({
      version: 2, status: 'done', source: 'manual', summaryText: 'A summary of the conversation.',
      summarizedToId: conversation.messages[2].id,
      keptUserMessageIds: [conversation.messages[0].id, conversation.messages[2].id],
    });
    expect(mockChat.mock.calls[0][0].at(-1)?.content).toContain('Do not call any tools');
  });

  it('uses the conversation model and its own provider credentials', async () => {
    seedConversation({ model: { providerId: 'own', modelId: 'own-model' } });
    expect((await compactConversationManually(CONV_ID)).compacted).toBe(true);
    expect(mockChat.mock.calls[0][1]).toMatchObject({
      model: 'own-model', apiKey: 'sk-own', baseUrl: 'https://own.example.net/v1',
      accounting: { source: 'compaction', conversationId: CONV_ID, providerInstanceId: 'own' },
    });
  });

  it('uses the index model when the loaded conversation has no model', async () => {
    seedConversation();
    useChatStore.setState({ conversationIndex: {
      [CONV_ID]: { id: CONV_ID, title: 'Task', createdAt: 1, updatedAt: 2, messageCount: 12, model: { providerId: 'own', modelId: 'own-model' } },
    } });
    expect((await compactConversationManually(CONV_ID)).compacted).toBe(true);
    expect(mockChat.mock.calls[0][1]).toMatchObject({ model: 'own-model', apiKey: 'sk-own' });
  });

  it('uses the configured default for a conversation with no model', async () => {
    seedConversation();
    expect((await compactConversationManually(CONV_ID)).compacted).toBe(true);
    expect(mockChat.mock.calls[0][1]).toMatchObject({ model: 'default-model', apiKey: 'sk-default' });
  });

  it('builds the shared prompt and tool settings for the conversation workspace without consuming onboarding', async () => {
    seedConversation();
    await compactConversationManually(CONV_ID);
    const options = mockChat.mock.calls[0][1];
    expect(options.systemPrompt).toContain('/task/workspace');
    expect(options.systemPrompt).not.toContain('/another/task');
    expect(options.systemPrompt).not.toContain('One-time Onboarding');
    expect(options.systemPromptSections?.length).toBeGreaterThan(0);
    expect(options.tools?.some((tool) => tool.name === 'read_file')).toBe(true);
    expect(options.maxTokens).toBe(4096);
    expect(useSettingsStore.getState().soulInitialized).toBe(false);
    expect(useWorkspaceStore.getState().currentPath).toBe('/another/task');
  });

  it('fits the final summary request including instruction, system prompt and tools into the input budget', async () => {
    const messages = buildRounds(2);
    messages[1].content = 'large assistant result '.repeat(20_000);
    seedConversation({ messages });
    useSettingsStore.setState({ contextWindowSize: 30_000 });
    expect((await compactConversationManually(CONV_ID)).compacted).toBe(true);
    const [sent, options] = mockChat.mock.calls[0];
    const used = estimateMessageTokens(sent) + estimateTokens(options.systemPrompt ?? '') + estimateToolSchemaTokens(options.tools ?? []);
    expect(used).toBeLessThanOrEqual(computeInputBudget(30_000, options.maxTokens!).inputBudget);
    expect(sent.at(-1)?.content).toContain('Do not call any tools');
    expect(sent.filter((message) => message.role === 'user').map((message) => message.id))
      .toEqual(['message-0', 'message-2', 'compaction-instruction']);
  });

  it('records a failed divider without sending a request when fixed user messages exceed the input budget', async () => {
    const messages = buildRounds(2);
    messages[0].content = 'fixed user requirements '.repeat(30_000);
    seedConversation({ messages });
    useSettingsStore.setState({ contextWindowSize: 30_000 });
    expect(await compactConversationManually(CONV_ID)).toEqual({ compacted: false, reason: 'summarize-failed' });
    expect(mockChat).not.toHaveBeenCalled();
    expect(storedConversation().messages.at(-1)?.compactBoundary?.status).toBe('failed');
  });

  it.each([undefined, 24576])('passes the configured local context length: %s', async (maxInputTokens) => {
    useSettingsStore.setState({ providers: [{
      ...provider('ollama'), source: 'builtin', baseUrl: 'http://127.0.0.1:11434', apiKey: '',
      models: [{ id: 'llama3.2', label: 'llama3.2', declaredCapabilities: maxInputTokens === undefined ? undefined : { maxInputTokens } }],
    }] });
    seedConversation({ model: { providerId: 'ollama', modelId: 'llama3.2' } });
    expect((await compactConversationManually(CONV_ID)).compacted).toBe(true);
    expect(mockChat.mock.calls[0][1]).toMatchObject({ model: 'llama3.2', localServer: true, requestedContextLength: maxInputTokens });
  });

  it.each([
    ['provider removed', []],
    ['provider disabled', [{ ...provider('own'), enabled: false }]],
    ['model removed', [{ ...provider('own'), models: [{ id: 'other-model', label: 'Other' }] }]],
  ])('makes no request when the pinned model is unavailable: %s', async (_label, providers) => {
    seedConversation({ model: { providerId: 'own', modelId: 'own-model' } });
    useSettingsStore.setState({ providers: providers as ProviderInstance[] });
    expect(await compactConversationManually(CONV_ID)).toEqual({ compacted: false, reason: 'model-unavailable' });
    expect(mockChat).not.toHaveBeenCalled();
    expect(storedConversation().messages).toHaveLength(12);
    expect(storedConversation().isCompressing).toBe(false);
  });

  it('uses gateway credentials when the credential adapter requires the gateway', async () => {
    seedConversation({ model: { providerId: 'own', modelId: 'own-model' } });
    useSettingsStore.setState({ providers: [] });
    vi.mocked(resolveEffectiveLlmCreds).mockReturnValue({
      apiKey: 'gateway-key', baseUrl: 'https://gateway.example.net/v1', forceOpenAiCompatible: true,
    });
    expect((await compactConversationManually(CONV_ID)).compacted).toBe(true);
    expect(mockChat.mock.calls[0][1]).toMatchObject({ model: 'own-model', apiKey: 'gateway-key', baseUrl: 'https://gateway.example.net/v1' });
  });

  it('accepts a conversation pinned to the gateway model', async () => {
    seedConversation({ model: { providerId: 'enterprise-gateway', modelId: 'gateway-model' } });
    expect((await compactConversationManually(CONV_ID)).compacted).toBe(true);
    expect(mockChat.mock.calls[0][1].model).toBe('gateway-model');
  });

  it('publishes the in-progress state during the request and clears it when finished', async () => {
    seedConversation();
    mockChat.mockImplementation(async (_messages, _options, onEvent) => {
      expect(storedConversation().isCompressing).toBe(true);
      onEvent({ type: 'text', text: 'Summary' });
      onEvent({ type: 'done', stopReason: 'end_turn' });
    });
    await compactConversationManually(CONV_ID);
    expect(storedConversation().isCompressing).toBe(false);
  });

  it.each(['request-failed', 'empty'])('records a failed divider and clears progress for %s', async (kind) => {
    seedConversation();
    if (kind === 'request-failed') mockChat.mockRejectedValue(new LLMError('rejected', 'invalid_request', { retryable: false }));
    else mockChat.mockImplementation(async (_messages, _options, onEvent) => onEvent({ type: 'done', stopReason: 'end_turn' }));
    expect(await compactConversationManually(CONV_ID)).toEqual({ compacted: false, reason: 'summarize-failed' });
    const marker = storedConversation().messages.at(-1)!;
    expect(isCompactBoundary(marker)).toBe(true);
    expect(marker.compactBoundary?.status).toBe('failed');
    expect(marker.loopId).toBeUndefined();
    expect(storedConversation().isCompressing).toBe(false);
  });
});
