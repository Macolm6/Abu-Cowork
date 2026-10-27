/**
 * Shared context utilities — used by contextManager, compaction, and tokenEstimator
 */

import type { MessageContent } from '../../types';

/**
 * Get text content from a Message
 */
export function getMessageText(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}
