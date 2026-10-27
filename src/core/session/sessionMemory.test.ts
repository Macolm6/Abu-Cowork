import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists, writeTextFile } from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { createConversationPaths } from './conversationPaths';
import {
  isDiskRef,
  extractRefId,
  DISK_REF_PREFIX,
  DISK_REF_SUFFIX,
  writeToolResultFile,
} from './sessionMemory';

describe('sessionMemory', () => {
  beforeEach(() => {
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(writeTextFile).mockClear();
  });

  describe('writeToolResultFile', () => {
    it.each(['../escape', '../../other/results/call', '/absolute/path', '..\\escape', 'C:\\outside\\call', 'call\u0000suffix'])('keeps provider ids inside the conversation results directory: %s', async (toolCallId) => {
      const dir = createConversationPaths(await appDataDir()).resultsDir('conversation-1');
      const path = await writeToolResultFile('conversation-1', toolCallId, 'complete result');
      expect(path.slice(0, dir.length + 1)).toBe(`${dir}/`);
      expect(path.slice(dir.length + 1)).toMatch(/^[0-9a-f]{64}\.txt$/);
      expect(writeTextFile).toHaveBeenCalledExactlyOnceWith(path, 'complete result');
    });

    it('preserves earlier references when a later run repeats a tool call id with new content', async () => {
      const first = await writeToolResultFile('conversation-1', 'reused-id', 'first result');
      const second = await writeToolResultFile('conversation-1', 'reused-id', 'second result');
      expect(first).not.toBe(second);
      expect(writeTextFile).toHaveBeenNthCalledWith(1, first, 'first result');
      expect(writeTextFile).toHaveBeenNthCalledWith(2, second, 'second result');
    });

    it('propagates a failed write', async () => {
      vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('disk full'));
      await expect(writeToolResultFile('conversation-1', 'call', 'result')).rejects.toThrow('disk full');
    });
  });

  describe('isDiskRef', () => {
    it('recognizes valid disk references', () => {
      const ref = `${DISK_REF_PREFIX}abc123${DISK_REF_SUFFIX}\npreview content`;
      expect(isDiskRef(ref)).toBe(true);
    });

    it('rejects non-references', () => {
      expect(isDiskRef('normal result')).toBe(false);
      expect(isDiskRef(`${DISK_REF_PREFIX}incomplete`)).toBe(false);
    });
  });

  describe('extractRefId', () => {
    it('extracts ID from valid reference', () => {
      const ref = `${DISK_REF_PREFIX}tc_12345${DISK_REF_SUFFIX}\nsome preview`;
      expect(extractRefId(ref)).toBe('tc_12345');
    });

    it('returns null for non-references', () => {
      expect(extractRefId('not a reference')).toBeNull();
    });
  });
});
