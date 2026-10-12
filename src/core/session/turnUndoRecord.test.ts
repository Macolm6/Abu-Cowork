import { describe, expect, it } from 'vitest';
import { parseTurnUndoRecord, pathHashOf, sha256Hex } from './turnUndoRecord';

const PATH = '/Users/testuser/project/plan.md';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

async function entryOf(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    path: PATH,
    hash: await pathHashOf(PATH),
    before: 'file',
    after: 'file',
    beforeSha256: SHA_A,
    afterSha256: SHA_B,
    ...overrides,
  };
}

function recordText(entries: unknown[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, loopId: 'loop-1', state: 'applied', entries, ...overrides });
}

describe('turnUndoRecord', () => {
  describe('sha256Hex', () => {
    it('gives the 64 hexadecimal digits of the SHA-256 of the bytes', async () => {
      await expect(sha256Hex(new TextEncoder().encode('abc'))).resolves.toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });
  });

  describe('pathHashOf', () => {
    it('gives the first 16 hexadecimal digits of the SHA-256 of the path', async () => {
      await expect(pathHashOf('abc')).resolves.toBe('ba7816bf8f01cfea');
    });
  });

  describe('parseTurnUndoRecord', () => {
    it('reads a record with its entries, state and last results', async () => {
      const created = '/Users/testuser/project/new.md';
      const entries = [
        await entryOf({ last: 'done' }),
        { path: created, hash: await pathHashOf(created), before: 'absent', after: 'file', afterSha256: SHA_B },
      ];

      await expect(parseTurnUndoRecord(recordText(entries, { state: 'undone' }))).resolves.toEqual({
        version: 1,
        loopId: 'loop-1',
        state: 'undone',
        entries,
      });
    });

    it('reads a Windows drive path', async () => {
      const path = 'C:/work/a.md';
      const entry = await entryOf({ path, hash: await pathHashOf(path) });
      const record = await parseTurnUndoRecord(recordText([entry]));
      expect(record.entries.map((item) => item.path)).toEqual([path]);
    });

    it.each([
      ['text that is no JSON object', '[]'],
      ['another version', recordText([], { version: 2 })],
      ['a loop id that is no text', recordText([], { loopId: 7 })],
      ['an unknown state', recordText([], { state: 'half' })],
      ['entries that are no list', recordText([], { entries: {} })],
    ])('rejects %s', async (_label, text) => {
      await expect(parseTurnUndoRecord(text)).rejects.toThrow('not in the saved format');
    });

    it.each<[string, Record<string, unknown>]>([
      ['a path that is no text', { path: 7 }],
      ['a relative path', { path: 'project/plan.md' }],
      ['a path with a parent segment', { path: '/Users/testuser/project/../.ssh/config' }],
      ['a path with backslashes', { path: 'C:\\work\\a.md' }],
      ['a hash that is not 16 hexadecimal digits', { hash: 'abc' }],
      ['a hash with upper-case digits', { hash: 'ABCDEF0123456789' }],
      ['an unknown before state', { before: 'oversized' }],
      ['an unknown after state', { after: 'gone' }],
      ['a before copy without its content hash', { beforeSha256: undefined }],
      ['an after content hash that is not 64 hexadecimal digits', { afterSha256: 'abc' }],
      ['an unknown last result', { last: 'maybe' }],
      ['a file that is absent on both sides', { before: 'absent', after: 'absent', beforeSha256: undefined, afterSha256: undefined }],
    ])('rejects an entry with %s', async (_label, overrides) => {
      await expect(parseTurnUndoRecord(recordText([await entryOf(overrides)]))).rejects.toThrow('not in the saved format');
    });

    it('rejects an entry that is no object', async () => {
      await expect(parseTurnUndoRecord(recordText(['x']))).rejects.toThrow('not in the saved format');
    });

    it('drops an entry whose hash is not the hash of its path and keeps the others', async () => {
      const outside = '/Users/testuser/.ssh/authorized_keys';
      const entries = [
        await entryOf({ path: outside }),
        await entryOf(),
      ];

      const record = await parseTurnUndoRecord(recordText(entries));

      expect(record.entries.map((entry) => entry.path)).toEqual([PATH]);
    });
  });
});
