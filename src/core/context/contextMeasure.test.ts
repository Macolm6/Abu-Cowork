import { describe, it, expect } from 'vitest';
import { measureInputTokens, usageContext, type UsageContext } from './contextMeasure';
import type { Message } from '@/types';

const context: UsageContext = {
  modelId: 'model-a', systemFingerprint: 'system', toolsFingerprint: 'tools', historyLength: 10,
};
const anchor = { ...context, promptTokens: 50_000, estimatedTokens: 40_000 };

describe('measureInputTokens', () => {
  it('is the local estimate when no request has returned usage yet', () => {
    expect(measureInputTokens(12_000, context, null)).toBe(12_000);
  });

  it('is the provider count plus the estimated change since that request', () => {
    expect(measureInputTokens(43_000, { ...context, historyLength: 11 }, anchor)).toBe(53_000);
  });

  it('ignores an anchor of another model: its tokenizer counts differently', () => {
    expect(measureInputTokens(43_000, { ...context, modelId: 'model-b' }, anchor)).toBe(43_000);
  });

  it('accepts an actual count smaller than the local estimate', () => {
    expect(measureInputTokens(43_000, context, { ...anchor, promptTokens: 30_000 })).toBe(33_000);
  });

  it('never measures below zero', () => {
    expect(measureInputTokens(0, context, { ...anchor, promptTokens: 1_000, estimatedTokens: 1_000 })).toBe(0);
  });

  it.each([
    { systemFingerprint: 'new instructions' },
    { toolsFingerprint: 'new tools' },
    { boundaryId: 'new-summary' },
    { historyLength: 9 },
  ])('invalidates a changed request context: %j', (change) => {
    expect(measureInputTokens(10_000, { ...context, ...change }, anchor)).toBe(10_000);
  });

  it('captures the successful boundary and serialized tool definitions', () => {
    const history: Message[] = [{
      id: 'compact-boundary-ok', role: 'system', content: '', timestamp: 0,
      compactBoundary: { version: 2, status: 'done', summaryText: 'summary', summarizedFromId: 'a', summarizedToId: 'b', createdAt: 0, source: 'auto' },
    }];
    expect(usageContext('model-a', 'system', [], history)).toEqual({
      ...context, historyLength: 1, boundaryId: history[0].id, toolsFingerprint: '[]',
    });
  });
});
