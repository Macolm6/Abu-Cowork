/**
 * When a conversation was last used, for ordering the sidebar lists: the time
 * the user last sent a message in it (`ConversationMeta.lastUserMessageAt`),
 * else its creation time. Replies, tool steps and status changes leave it
 * alone, so a running conversation keeps its place while it answers.
 *
 * Pure: no store, no I/O, never throws.
 */
import type { Message } from '@/types';
import type { ConversationMeta } from './conversationWriter';

type ActivityFields = Pick<ConversationMeta, 'id' | 'createdAt' | 'lastUserMessageAt'>;

export function conversationActivityAt(meta: Pick<ConversationMeta, 'createdAt' | 'lastUserMessageAt'>): number {
  return meta.lastUserMessageAt ?? meta.createdAt;
}

/** Most recently used first; equal times keep a fixed order by id. */
export function compareByRecentActivity(a: ActivityFields, b: ActivityFields): number {
  const byTime = conversationActivityAt(b) - conversationActivityAt(a);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The timestamp of the last message the user sent; system-injected user rows do not count. */
export function lastUserMessageAt(messages: readonly Pick<Message, 'role' | 'isSystem' | 'timestamp'>[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user' && !message.isSystem) return message.timestamp;
  }
  return undefined;
}

/**
 * An index entry written before `lastUserMessageAt` existed takes its
 * `updatedAt`, the time of its last message, so conversations used before the
 * upgrade keep their recency. An entry with no messages, or one that already
 * has the field, is returned as it is.
 */
export function withLastUserMessageAt<T extends Pick<ConversationMeta, 'updatedAt' | 'messageCount' | 'lastUserMessageAt'>>(entry: T): T {
  if (entry.lastUserMessageAt !== undefined || !(entry.messageCount > 0)) return entry;
  return { ...entry, lastUserMessageAt: entry.updatedAt };
}
