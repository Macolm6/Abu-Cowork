/**
 * How large the next request is, in input tokens.
 *
 * The last request's size as the provider counted it is exact; everything the
 * conversation gained or lost since then is estimated. So the measurement is
 * the provider's number plus the change in the local estimate between that
 * request and this one. DSH (`TokenMeter.measure`) and Codex
 * (`get_total_token_usage`) measure the same way.
 *
 * A changed request prefix, model, compaction boundary or shortened history
 * invalidates the anchor. Missing usage clears it at the request boundary.
 */

import type { Message, ToolDefinition } from '@/types';
import { findLastCompactBoundary } from './compactBoundary';

export interface UsageContext {
  modelId: string;
  systemFingerprint: string;
  toolsFingerprint: string;
  historyLength: number;
  boundaryId?: string;
}

export function usageContext(
  modelId: string,
  systemPrompt: string,
  tools: ToolDefinition[],
  history: Message[],
): UsageContext {
  return {
    modelId,
    systemFingerprint: systemPrompt,
    toolsFingerprint: JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))),
    historyLength: history.length,
    boundaryId: findLastCompactBoundary(history)?.marker.id,
  };
}

/** The last request whose usage the provider returned. */
export interface UsageAnchor extends UsageContext {
  /** Whole prompt of that request as the provider counted it (`promptTokensOf`). */
  promptTokens: number;
  /** Local estimate of the same request, made the same way as `estimatedTokens` below. */
  estimatedTokens: number;
}

export function measureInputTokens(
  estimatedTokens: number,
  context: UsageContext,
  anchor: UsageAnchor | null,
): number {
  if (!anchor
    || anchor.modelId !== context.modelId
    || anchor.systemFingerprint !== context.systemFingerprint
    || anchor.toolsFingerprint !== context.toolsFingerprint
    || anchor.boundaryId !== context.boundaryId
    || context.historyLength < anchor.historyLength) {
    return estimatedTokens;
  }
  return Math.max(0, anchor.promptTokens + estimatedTokens - anchor.estimatedTokens);
}
