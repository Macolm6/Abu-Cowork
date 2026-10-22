/**
 * Request-shape fixture for the Claude adapter's thinking replay (model
 * profile brief §3.2 / §4.1).
 *
 * `history` is the conversation as Abu stores it after one tool-using turn
 * of a Claude model with extended thinking on: the assistant message holds
 * the thinking text, the signature the API issued for it, and the tool call
 * with its result. `expectedRequest` is the body `claude.ts` must put on the
 * wire for the next turn — captured through a fake `fetch` by
 * `claudeThinkingReplay.contract.test.ts`, so any change to how the
 * normalizer and the serializer carry the signature turns that test red.
 */

import type { Message } from '../../../types';

export const CLAUDE_THINKING_REPLAY_HISTORY: Message[] = [
  { id: 'u1', role: 'user', content: 'What time is it in Tokyo?', timestamp: 1_700_000_000_000 },
  {
    id: 'a1',
    role: 'assistant',
    content: '',
    timestamp: 1_700_000_000_001,
    thinking: 'The user wants the current time in Tokyo. I should call get_time with that zone.',
    thinkingSignature: 'ErUBCkYIAhgCIkDLjOrvE5TLRcL6j3u1J1vzsignature-fixture-bytes',
    toolCallsForContext: [
      { name: 'get_time', input: { zone: 'Asia/Tokyo' }, result: '2026-10-19T21:00:00+09:00' },
    ],
  },
];

export const CLAUDE_THINKING_REPLAY_OPTIONS = {
  model: 'claude-sonnet-4-6',
  maxTokens: 4096,
  enableThinking: true,
  thinkingBudget: 2048,
  tools: [
    {
      name: 'get_time',
      description: 'Current time in a zone',
      inputSchema: { type: 'object', properties: { zone: { type: 'string' } }, required: ['zone'] },
    },
  ],
};

export const CLAUDE_THINKING_REPLAY_EXPECTED_REQUEST = {
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
  stream: true,
  temperature: 1,
  thinking: { type: 'enabled', budget_tokens: 2048 },
  tools: [
    {
      name: 'get_time',
      description: 'Current time in a zone',
      input_schema: { type: 'object', properties: { zone: { type: 'string' } }, required: ['zone'] },
      cache_control: { type: 'ephemeral' },
    },
  ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'What time is it in Tokyo?' }] },
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'The user wants the current time in Tokyo. I should call get_time with that zone.',
          signature: 'ErUBCkYIAhgCIkDLjOrvE5TLRcL6j3u1J1vzsignature-fixture-bytes',
        },
        { type: 'tool_use', id: 'toolu_1_0', name: 'get_time', input: { zone: 'Asia/Tokyo' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1_0',
          content: '2026-10-19T21:00:00+09:00',
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  ],
};
