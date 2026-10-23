import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@/types';
import { selectToolsForProfile } from './toolSelection';
import { TOOL_NAMES } from './toolNames';

function tool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => '',
    ...extra,
  };
}

const roster = [
  tool(TOOL_NAMES.READ_FILE),
  tool(TOOL_NAMES.WRITE_FILE),
  tool(TOOL_NAMES.EDIT_FILE, { descriptionByFamily: { gpt: 'edit_file for gpt' } }),
  tool(TOOL_NAMES.APPLY_PATCH, { descriptionByFamily: { gpt: 'apply_patch for gpt' } }),
  tool(TOOL_NAMES.RUN_COMMAND),
];

const patchProfile = { harness: { editToolStyle: 'patch' as const, promptVariant: 'gpt' as const, guards: { textOnlyEndTurnNudge: false, toolArgumentRepair: false } } };
const replaceProfile = { harness: { editToolStyle: 'replace' as const, promptVariant: 'deepseek' as const, guards: { textOnlyEndTurnNudge: false, toolArgumentRepair: true } } };

describe('selectToolsForProfile', () => {
  it('keeps apply_patch and withdraws edit_file and write_file for the patch style', () => {
    const names = selectToolsForProfile(roster, patchProfile).map((t) => t.name);
    expect(names).toEqual([TOOL_NAMES.READ_FILE, TOOL_NAMES.APPLY_PATCH, TOOL_NAMES.RUN_COMMAND]);
  });

  it('withdraws apply_patch for the replace style and leaves the rest in order', () => {
    const names = selectToolsForProfile(roster, replaceProfile).map((t) => t.name);
    expect(names).toEqual([TOOL_NAMES.READ_FILE, TOOL_NAMES.WRITE_FILE, TOOL_NAMES.EDIT_FILE, TOOL_NAMES.RUN_COMMAND]);
  });

  it('keeps edit_file and write_file under the patch style when apply_patch is not in the roster', () => {
    const withoutPatch = roster.filter((t) => t.name !== TOOL_NAMES.APPLY_PATCH);
    const names = selectToolsForProfile(withoutPatch, patchProfile).map((t) => t.name);
    expect(names).toEqual([TOOL_NAMES.READ_FILE, TOOL_NAMES.WRITE_FILE, TOOL_NAMES.EDIT_FILE, TOOL_NAMES.RUN_COMMAND]);
  });

  it('swaps in the description written for the prompt variant and leaves the others', () => {
    const selected = selectToolsForProfile(roster, patchProfile);
    expect(selected.find((t) => t.name === TOOL_NAMES.APPLY_PATCH)?.description).toBe('apply_patch for gpt');
    expect(selected.find((t) => t.name === TOOL_NAMES.RUN_COMMAND)?.description).toBe('run_command description');
  });

  it('reads the base description when no variant exists for the family', () => {
    const selected = selectToolsForProfile(roster, replaceProfile);
    expect(selected.find((t) => t.name === TOOL_NAMES.EDIT_FILE)?.description).toBe('edit_file description');
  });

  it('returns the same tool object when nothing about it changes', () => {
    const selected = selectToolsForProfile(roster, replaceProfile);
    expect(selected.find((t) => t.name === TOOL_NAMES.READ_FILE)).toBe(roster[0]);
  });

  it('does not mutate the roster it was given', () => {
    const before = roster.map((t) => ({ name: t.name, description: t.description }));
    selectToolsForProfile(roster, patchProfile);
    expect(roster.map((t) => ({ name: t.name, description: t.description }))).toEqual(before);
  });
});
