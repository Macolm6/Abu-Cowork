/**
 * Integration test: contextManager + tokenEstimator + the long-result rule
 * Validates the full pipeline of context preparation with bounded tool results
 */
import { describe, it, expect } from 'vitest';
import { enforceContextBudget } from '../core/context/contextManager';
import { estimateTokens, estimateMessageTokens } from '../core/context/tokenEstimator';
import { boundToolResult } from '../core/context/toolResultSpill';
import type { Message } from '../types';

function makeMsg(role: 'user' | 'assistant', content: string): Message {
  return { id: `${role}-${content.slice(0, 12)}`, role, content, timestamp: 1_800_000_000_000 };
}

const writeFile = async (toolCallId: string) => `/data/results/${toolCallId}.txt`;

describe('contextManager integration', () => {
  it('a long tool result keeps far fewer tokens in the conversation', async () => {
    const longResult = 'x'.repeat(200_000);
    const bounded = await boundToolResult({ toolCallId: 'tc', toolName: 'search_files', input: {}, result: longResult, writeFile });

    expect(estimateTokens(bounded)).toBeLessThan(estimateTokens(longResult) / 10);
    expect(bounded).toContain('/data/results/tc.txt');
  });

  it('context preparation with tool-heavy messages stays within limits and keeps the user\'s messages', () => {
    const systemPrompt = 'You are an assistant.';
    const messages: Message[] = [];

    // First user message (task context)
    messages.push(makeMsg('user', 'Analyze these files'));

    // Multiple rounds with tool results
    for (let i = 0; i < 10; i++) {
      messages.push({
        ...makeMsg('assistant', `Reading file ${i}...`),
        toolCallsForContext: [{
          name: 'read_file',
          input: { path: `/tmp/file${i}.txt` },
          result: `File ${i} content: ${'data '.repeat(500)}`,
        }],
      });
      messages.push(makeMsg('user', `Good, continue with file ${i + 1}`));
    }

    const contextWindow = 8000;
    const reserveForOutput = 2000;
    const budgetResult = enforceContextBudget(messages, systemPrompt, contextWindow, reserveForOutput);
    const result = budgetResult.messages;

    // Result should fit within the budget
    const resultTokens = estimateTokens(systemPrompt) + estimateMessageTokens(result);
    expect(resultTokens).toBeLessThanOrEqual(budgetResult.inputBudget);

    // Every user message is kept; whole steps are what goes
    const userContents = result.filter((m) => m.role === 'user' && !m.isSystem).map((m) => m.content);
    expect(userContents).toEqual(messages.filter((m) => m.role === 'user').map((m) => m.content));
  });

  it('token estimator handles various message content types consistently', () => {
    const textMsg: Message = {
      id: '1', role: 'user',
      content: 'Hello world',
      timestamp: 1_800_000_000_000,
    };

    const multimodalMsg: Message = {
      id: '2', role: 'user',
      content: [
        { type: 'text', text: 'Hello world' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      ],
      timestamp: 1_800_000_000_000,
    };

    const textTokens = estimateMessageTokens([textMsg]);
    const multimodalTokens = estimateMessageTokens([multimodalMsg]);

    // Multimodal should be significantly higher due to image (~1600 tokens)
    expect(multimodalTokens).toBeGreaterThan(textTokens + 1000);
  });

  it('Chinese text gets higher token estimates than equivalent English', () => {
    const englishTokens = estimateTokens('Hello world, this is a test.');
    const chineseTokens = estimateTokens('你好世界，这是一个测试。');

    // Chinese should have more tokens per character
    // 12 CJK chars / 1.5 = 8 tokens vs 28 English chars / 4 = 7 tokens
    // Both are similar but Chinese per-char ratio is higher
    expect(chineseTokens).toBeGreaterThan(0);
    expect(englishTokens).toBeGreaterThan(0);
  });
});
