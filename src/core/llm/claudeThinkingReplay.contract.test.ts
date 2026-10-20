import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CLAUDE_THINKING_REPLAY_EXPECTED_REQUEST,
  CLAUDE_THINKING_REPLAY_HISTORY,
  CLAUDE_THINKING_REPLAY_OPTIONS,
} from './__contractFixtures__/claudeThinkingReplayFixture';

/**
 * Wire contract for the Claude adapter's thinking replay (brief §3.2 / §4.1):
 * the real `ClaudeAdapter` and the real Anthropic SDK assemble the request,
 * a fake `fetch` captures the body, and the body is compared whole against
 * the fixture. Only the transport is replaced.
 */

const capturedBodies: string[] = [];

// The global setup replaces the Anthropic SDK with a stub; this contract
// needs the real SDK so the captured body is what production sends.
vi.unmock('@anthropic-ai/sdk');

vi.mock('./tauriFetch', () => ({
  getTauriFetch: vi.fn().mockResolvedValue(async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBodies.push(String(init?.body));
    const sse = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }),
}));

import { ClaudeAdapter } from './claude';

describe('Claude thinking replay — request body contract', () => {
  beforeEach(() => {
    capturedBodies.length = 0;
  });

  it('puts the signed thinking block on the wire exactly as the fixture says', async () => {
    const adapter = new ClaudeAdapter();
    await adapter.chat(
      CLAUDE_THINKING_REPLAY_HISTORY,
      { apiKey: 'test-key', ...CLAUDE_THINKING_REPLAY_OPTIONS },
      () => {},
    );

    expect(capturedBodies).toHaveLength(1);
    expect(JSON.parse(capturedBodies[0])).toEqual(CLAUDE_THINKING_REPLAY_EXPECTED_REQUEST);
  });
});
