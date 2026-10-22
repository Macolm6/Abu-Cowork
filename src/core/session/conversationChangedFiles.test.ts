import { describe, expect, it } from 'vitest';
import type { FileChange } from '@/types/fileChange';
import { collectConversationChangedFiles, type ConversationTurn } from './conversationChangedFiles';
import type { TurnIndexFile } from './turnChanges';

const WS = '/ws';

function file(display: string, status: TurnIndexFile['status'], path = `${WS}/${display}`): TurnIndexFile {
  return { path, display, status };
}

function turn(loopId: string, files: TurnIndexFile[], undone = false): ConversationTurn {
  const at = Number(loopId.replace(/\D/g, '')) * 1000;
  return { loopId, prompt: `prompt of ${loopId}`, at, files, undone };
}

function change(display: string, kind: FileChange['kind']): FileChange {
  return { path: `${WS}/${display}`, kind };
}

function statuses(turns: ConversationTurn[], running: Parameters<typeof collectConversationChangedFiles>[1] = null): Array<[string, string]> {
  return collectConversationChangedFiles(turns, running).map((entry) => [entry.display, entry.status]);
}

describe('collectConversationChangedFiles', () => {
  describe('status across turns', () => {
    it.each<[string, TurnIndexFile['status'], TurnIndexFile['status'], string | null]>([
      ['created, then modified', 'created', 'modified', 'created'],
      ['created, then deleted', 'created', 'deleted', null],
      ['deleted, then created', 'deleted', 'created', 'modified'],
      ['modified, then deleted', 'modified', 'deleted', 'deleted'],
      ['modified twice', 'modified', 'modified', 'modified'],
    ])('marks a file %s from the state before its first change and after its last', (_label, first, last, expected) => {
      const result = statuses([turn('loop-1', [file('a.md', first)]), turn('loop-3', [file('a.md', last)])]);
      expect(result).toEqual(expected === null ? [] : [['a.md', expected]]);
    });

    it('takes the state before a file was created again, after it was created and deleted in earlier turns', () => {
      const turns = [
        turn('loop-1', [file('a.md', 'created')]),
        turn('loop-2', [file('a.md', 'deleted')]),
        turn('loop-3', [file('a.md', 'created')]),
      ];
      expect(statuses(turns)).toEqual([['a.md', 'created']]);
    });
  });

  describe('undone turns', () => {
    it('leaves out a turn that is undone and counts it again once it is not', () => {
      const turns = [turn('loop-1', [file('a.md', 'created')]), turn('loop-2', [file('a.md', 'deleted'), file('b.md', 'modified')], true)];
      expect(statuses(turns)).toEqual([['a.md', 'created']]);
      turns[1] = { ...turns[1], undone: false };
      expect(statuses(turns)).toEqual([['b.md', 'modified']]);
    });
  });

  describe('order', () => {
    it('puts the files whose last change is in a later turn first, and orders one turn by display path', () => {
      const turns = [
        turn('loop-1', [file('a.md', 'modified'), file('z.md', 'created')]),
        turn('loop-2', [file('b.md', 'created'), file('m.md', 'modified')]),
        turn('loop-3', [file('a.md', 'modified')]),
      ];
      expect(statuses(turns).map(([display]) => display)).toEqual(['a.md', 'b.md', 'm.md', 'z.md']);
    });
  });

  describe('spellings of one path', () => {
    it('lists a path once whatever its separators or a trailing separator', () => {
      const turns = [
        turn('loop-1', [file('b.txt', 'created', 'C:\\a\\b.txt')]),
        turn('loop-2', [file('b.txt', 'modified', 'C:/a/b.txt')]),
        turn('loop-3', [file('b.txt', 'modified', 'C:/a/b.txt/')]),
      ];
      const result = collectConversationChangedFiles(turns, null);
      expect(result.map((entry) => [entry.display, entry.status, entry.turns.length])).toEqual([['b.txt', 'created', 3]]);
    });
  });

  describe('the running turn', () => {
    it('adds the changes of the running turn by their kind, first', () => {
      const result = collectConversationChangedFiles(
        [turn('loop-1', [file('a.md', 'modified')])],
        {
          loopId: 'loop-2',
          prompt: 'now',
          at: 2000,
          changes: [change('z.md', 'create'), change('a.md', 'delete'), change('m.md', 'modify')],
        },
      );
      expect(result.map((entry) => [entry.path, entry.status])).toEqual([
        [`${WS}/a.md`, 'deleted'],
        [`${WS}/m.md`, 'modified'],
        [`${WS}/z.md`, 'created'],
      ]);
      expect(result[0].turns.map((entry) => entry.loopId)).toEqual(['loop-2', 'loop-1']);
    });

    it('takes the first and last change of a file within the running turn', () => {
      const running = { loopId: 'loop-1', prompt: 'now', at: 1000, changes: [change('a.md', 'create'), change('a.md', 'modify'), change('b.md', 'create'), change('b.md', 'delete')] };
      expect(statuses([], running)).toEqual([[`${WS}/a.md`, 'created']]);
    });

    it('uses the saved turn once the running turn is in the turns', () => {
      const running = { loopId: 'loop-1', prompt: 'now', at: 1000, changes: [change('a.md', 'create')] };
      expect(statuses([turn('loop-1', [file('b.md', 'modified')])], running)).toEqual([['b.md', 'modified']]);
    });
  });

  describe('turns of a file', () => {
    it('lists the turns that changed a file, latest first, with the file index in each turn and its prompt and time', () => {
      const turns = [
        turn('loop-2', [file('a.md', 'modified'), file('b.md', 'modified')]),
        turn('loop-5', [file('b.md', 'modified')]),
      ];
      const [entry] = collectConversationChangedFiles(turns, null);
      expect(entry.display).toBe('b.md');
      expect(entry.turns).toEqual([
        { loopId: 'loop-5', prompt: 'prompt of loop-5', at: 5000, fileIndex: 0 },
        { loopId: 'loop-2', prompt: 'prompt of loop-2', at: 2000, fileIndex: 1 },
      ]);
    });
  });
});
