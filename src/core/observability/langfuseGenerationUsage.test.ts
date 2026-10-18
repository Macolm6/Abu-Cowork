import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trace: vi.fn(),
  generation: vi.fn(),
  generationEnd: vi.fn(),
}));

vi.mock('langfuse', () => ({
  Langfuse: class MockLangfuse {
    trace(input: unknown) {
      return mocks.trace(input);
    }

    flushAsync() {
      return Promise.resolve();
    }
  },
}));

describe('startGeneration usage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_LANGFUSE_PUBLIC_KEY', 'public-test-key');
    vi.stubEnv('VITE_LANGFUSE_SECRET_KEY', 'secret-test-key');
    vi.stubEnv('VITE_LANGFUSE_BASE_URL', 'https://langfuse.example.test');
    mocks.trace.mockReset();
    mocks.generation.mockReset();
    mocks.generationEnd.mockReset();
    mocks.generation.mockReturnValue({ end: mocks.generationEnd });
    mocks.trace.mockReturnValue({ generation: mocks.generation, span: vi.fn(), update: vi.fn() });
  });

  async function endGeneration(
    protocol: 'anthropic' | 'openai-compatible',
    usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number },
  ) {
    const { startConversationTrace, startGeneration } = await import('./langfuse');
    startConversationTrace('conv-usage', {});
    startGeneration('conv-usage', { model: 'test-model', input: [], protocol }).end({ usage, costUsd: 0.5 });
    return mocks.generationEnd.mock.calls[0]?.[0]?.usage;
  }

  it('reports the whole prompt including cache reads and writes on the Anthropic protocol', async () => {
    // Anthropic 的 inputTokens 不含缓存读写，只取它会让 Langfuse 上的输入与合计少掉缓存的部分。
    const usage = await endGeneration('anthropic', {
      inputTokens: 600,
      outputTokens: 25,
      cacheReadInputTokens: 48_000,
      cacheCreationInputTokens: 1_400,
    });

    expect(usage).toEqual({ input: 50_000, output: 25, total: 50_025, unit: 'TOKENS', totalCost: 0.5 });
  });

  it('reports prompt_tokens as the input on the OpenAI-compatible protocol', async () => {
    // prompt_tokens 已经包含缓存读，不能再加一次。
    const usage = await endGeneration('openai-compatible', {
      inputTokens: 1_000,
      outputTokens: 25,
      cacheReadInputTokens: 800,
    });

    expect(usage).toEqual({ input: 1_000, output: 25, total: 1_025, unit: 'TOKENS', totalCost: 0.5 });
  });
});
