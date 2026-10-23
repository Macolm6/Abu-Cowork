import { describe, expect, it, vi } from 'vitest';
import type { ToolCall, ToolDefinition } from '../../types';
import { repairToolArguments, repairToolCallsForProfile } from './toolArgumentRepair';

const schema: ToolDefinition['inputSchema'] = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'path' },
    count: { type: 'number', description: 'count' },
    limit: { type: 'integer', description: 'limit' },
    recursive: { type: 'boolean', description: 'recursive' },
    options: {
      type: 'object',
      description: 'options',
      properties: {
        depth: { type: 'integer', description: 'depth' },
        dryRun: { type: 'boolean', description: 'dry run' },
      },
    },
    files: {
      type: 'array',
      description: 'files',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'name' },
          size: { type: 'number', description: 'size' },
        },
      },
    },
    tags: { type: 'array', description: 'tags', items: { type: 'string' } },
  },
  required: ['path'],
};

describe('repairToolArguments', () => {
  describe('stringified JSON', () => {
    it('parses an object written as a JSON string', () => {
      const { input, repairedPaths } = repairToolArguments({ path: 'a', options: '{"depth": 2}' }, schema);
      expect(input.options).toEqual({ depth: 2 });
      expect(repairedPaths).toEqual(['options']);
    });

    it('parses an array written as a JSON string and repairs its items', () => {
      const { input, repairedPaths } = repairToolArguments(
        { path: 'a', files: '[{"name": "x", "size": "12"}]' },
        schema,
      );
      expect(input.files).toEqual([{ name: 'x', size: 12 }]);
      expect(repairedPaths).toEqual(['files', 'files[0].size']);
    });

    it('leaves a string that is not JSON of the declared shape alone', () => {
      const asArray = repairToolArguments({ path: 'a', options: '[1, 2]' }, schema);
      expect(asArray.input.options).toBe('[1, 2]');
      const broken = repairToolArguments({ path: 'a', options: '{not json' }, schema);
      expect(broken.input.options).toBe('{not json');
      expect(asArray.repairedPaths).toEqual([]);
      expect(broken.repairedPaths).toEqual([]);
    });
  });

  describe('numbers', () => {
    it('turns a numeric literal into a number, including negative and decimal literals', () => {
      const { input, repairedPaths } = repairToolArguments({ path: 'a', count: ' -3.5 ' }, schema);
      expect(input.count).toBe(-3.5);
      expect(repairedPaths).toEqual(['count']);
    });

    it('turns an integer literal into a number for an integer field', () => {
      expect(repairToolArguments({ path: 'a', limit: '20' }, schema).input.limit).toBe(20);
    });

    it('leaves a decimal literal alone for an integer field', () => {
      expect(repairToolArguments({ path: 'a', limit: '2.5' }, schema).input.limit).toBe('2.5');
    });

    it('leaves a string that is not a numeric literal alone', () => {
      expect(repairToolArguments({ path: 'a', count: 'ten' }, schema).input.count).toBe('ten');
      expect(repairToolArguments({ path: 'a', count: '' }, schema).input.count).toBe('');
      expect(repairToolArguments({ path: 'a', count: '0x10' }, schema).input.count).toBe('0x10');
    });

    it('leaves a number that already is a number untouched', () => {
      const { input, repairedPaths } = repairToolArguments({ path: 'a', count: 4 }, schema);
      expect(input.count).toBe(4);
      expect(repairedPaths).toEqual([]);
    });
  });

  describe('booleans', () => {
    it('turns "true" / "false" into booleans, case-insensitively', () => {
      expect(repairToolArguments({ path: 'a', recursive: 'true' }, schema).input.recursive).toBe(true);
      expect(repairToolArguments({ path: 'a', recursive: 'False' }, schema).input.recursive).toBe(false);
    });

    it('leaves any other string alone', () => {
      expect(repairToolArguments({ path: 'a', recursive: 'yes' }, schema).input.recursive).toBe('yes');
      expect(repairToolArguments({ path: 'a', recursive: '1' }, schema).input.recursive).toBe('1');
    });
  });

  describe('null', () => {
    it('removes null from an optional field', () => {
      const { input, repairedPaths } = repairToolArguments({ path: 'a', count: null }, schema);
      expect('count' in input).toBe(false);
      expect(repairedPaths).toEqual(['count']);
    });

    it('keeps null on a required field for the tool to reject', () => {
      const { input, repairedPaths } = repairToolArguments({ path: null }, schema);
      expect(input.path).toBeNull();
      expect(repairedPaths).toEqual([]);
    });

    it('removes null from an optional nested field', () => {
      const { input, repairedPaths } = repairToolArguments({ path: 'a', options: { depth: null, dryRun: 'true' } }, schema);
      expect(input.options).toEqual({ dryRun: true });
      expect(repairedPaths).toEqual(['options.depth', 'options.dryRun']);
    });
  });

  describe('what it does not touch', () => {
    it('returns the same object when nothing needed repair', () => {
      const original = { path: 'a', count: 1, recursive: true, tags: ['x'] };
      const { input, repairedPaths } = repairToolArguments(original, schema);
      expect(input).toBe(original);
      expect(repairedPaths).toEqual([]);
    });

    it('does not mutate the input it was given', () => {
      const original = { path: 'a', count: '7', options: '{"depth": "1"}' };
      repairToolArguments(original, schema);
      expect(original).toEqual({ path: 'a', count: '7', options: '{"depth": "1"}' });
    });

    it('leaves fields the schema does not declare untouched', () => {
      const { input } = repairToolArguments({ path: 'a', extra: '42' }, schema);
      expect(input.extra).toBe('42');
    });

    it('skips a call whose arguments did not parse', () => {
      const broken = { _parse_error: 'bad json', count: '1' };
      const { input, repairedPaths } = repairToolArguments(broken, schema);
      expect(input).toBe(broken);
      expect(repairedPaths).toEqual([]);
    });

    it('leaves array items of a primitive type alone when the literal does not fit', () => {
      const { input } = repairToolArguments({ path: 'a', tags: ['x', 1] }, schema);
      expect(input.tags).toEqual(['x', 1]);
    });
  });
});

describe('repairToolCallsForProfile', () => {
  const tools: ToolDefinition[] = [
    { name: 'list_dir', description: 'list', inputSchema: schema, execute: async () => 'ok' },
  ];
  const calls: ToolCall[] = [
    { id: '1', name: 'list_dir', input: { path: 'a', count: '3' } },
    { id: '2', name: 'unknown_tool', input: { count: '3' } },
    { id: '3', name: 'list_dir', input: { path: 'b' } },
  ];
  const profileOn = { harness: { editToolStyle: 'replace', promptVariant: 'other', guards: { textOnlyEndTurnNudge: false, toolArgumentRepair: true } } } as const;
  const profileOff = { harness: { ...profileOn.harness, guards: { textOnlyEndTurnNudge: false, toolArgumentRepair: false } } } as const;

  it('repairs only the calls whose tool is known and whose arguments changed, and logs each without values', () => {
    const log = { info: vi.fn() };
    const repaired = repairToolCallsForProfile(calls, tools, profileOn, log);
    expect(repaired[0]).toEqual({ id: '1', name: 'list_dir', input: { path: 'a', count: 3 } });
    expect(repaired[1]).toBe(calls[1]);
    expect(repaired[2]).toBe(calls[2]);
    expect(log.info).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith('Repaired tool arguments before dispatch', { tool: 'list_dir', fields: ['count'] });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('"3"');
  });

  it('returns the calls as they are when the profile keeps the guard off', () => {
    const log = { info: vi.fn() };
    expect(repairToolCallsForProfile(calls, tools, profileOff, log)).toBe(calls);
    expect(log.info).not.toHaveBeenCalled();
  });
});
