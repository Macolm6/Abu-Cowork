import { describe, expect, it } from 'vitest';
import {
  compareByRecentActivity,
  conversationActivityAt,
  lastUserMessageAt,
  withLastUserMessageAt,
} from './conversationActivity';

describe('conversationActivityAt', () => {
  it('is the last user message time, else the creation time', () => {
    expect(conversationActivityAt({ createdAt: 100, lastUserMessageAt: 500 })).toBe(500);
    expect(conversationActivityAt({ createdAt: 100 })).toBe(100);
    expect(conversationActivityAt({ createdAt: 100, lastUserMessageAt: null })).toBe(100);
  });
});

describe('compareByRecentActivity', () => {
  it('puts an old conversation the user just wrote in above a newer idle one', () => {
    const old = { id: 'old', createdAt: 100, lastUserMessageAt: 900 };
    const newer = { id: 'newer', createdAt: 500, lastUserMessageAt: 500 };
    const fresh = { id: 'fresh', createdAt: 700 };
    expect([newer, fresh, old].sort(compareByRecentActivity).map((c) => c.id)).toEqual(['old', 'fresh', 'newer']);
  });

  it('orders equal times by id, whatever the input order', () => {
    const a = { id: 'a', createdAt: 1, lastUserMessageAt: 5 };
    const b = { id: 'b', createdAt: 2, lastUserMessageAt: 5 };
    expect([b, a].sort(compareByRecentActivity).map((c) => c.id)).toEqual(['a', 'b']);
    expect([a, b].sort(compareByRecentActivity).map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('lastUserMessageAt', () => {
  it('takes the last user message and passes over replies and system-injected user rows', () => {
    expect(lastUserMessageAt([
      { role: 'user', timestamp: 10 },
      { role: 'assistant', timestamp: 20 },
      { role: 'user', timestamp: 30 },
      { role: 'user', isSystem: true, timestamp: 40 },
      { role: 'assistant', timestamp: 50 },
    ])).toBe(30);
  });

  it('is undefined when the user has sent nothing', () => {
    expect(lastUserMessageAt([])).toBeUndefined();
    expect(lastUserMessageAt([{ role: 'assistant', timestamp: 20 }, { role: 'user', isSystem: true, timestamp: 30 }])).toBeUndefined();
  });
});

describe('withLastUserMessageAt', () => {
  it('gives an entry from before the field its updatedAt', () => {
    expect(withLastUserMessageAt({ updatedAt: 300, messageCount: 4 })).toEqual({ updatedAt: 300, messageCount: 4, lastUserMessageAt: 300 });
  });

  it('returns the same object for an entry that has the field or has no messages', () => {
    const current = { updatedAt: 300, messageCount: 4, lastUserMessageAt: 200 };
    const empty = { updatedAt: 300, messageCount: 0 };
    const systemOnly = { updatedAt: 300, messageCount: 2, lastUserMessageAt: null };
    expect(withLastUserMessageAt(current)).toBe(current);
    expect(withLastUserMessageAt(empty)).toBe(empty);
    expect(withLastUserMessageAt(systemOnly)).toBe(systemOnly);
  });
});
