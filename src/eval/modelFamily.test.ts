import { describe, expect, it } from 'vitest';
import { EVAL_MODEL_FAMILIES, resolveEvalFamily } from './modelFamily';

describe('resolveEvalFamily', () => {
  it.each([
    ['claude-sonnet-5', 'claude'],
    ['claude-opus-5', 'claude'],
    ['anthropic/claude-haiku-4-5-20251001', 'claude'],
    ['gpt-5.6-sol', 'gpt'],
    ['gpt-4.1', 'gpt'],
    ['gpt-4o-mini', 'gpt'],
    ['o3-mini', 'gpt'],
    ['deepseek-v4-pro', 'deepseek'],
    ['deepseek/deepseek-v3.2-251201', 'deepseek'],
    ['kimi-k3', 'kimi'],
    ['moonshotai/kimi-k2.5', 'kimi'],
    ['qwen3.7-plus', 'qwen'],
    ['qwq-32b', 'qwen'],
    ['glm-5.3', 'glm'],
    ['GLM-5V-Turbo', 'glm'],
    ['MiniMax-M3', 'other'],
    ['doubao-seed-2.0-lite', 'other'],
    ['llama3', 'other'],
  ])('maps %s to %s', (modelId, family) => {
    expect(resolveEvalFamily(modelId)).toBe(family);
  });

  it('lists every family a result can be filed under', () => {
    expect(EVAL_MODEL_FAMILIES).toEqual(['claude', 'gpt', 'deepseek', 'kimi', 'qwen', 'glm', 'other']);
  });
});
