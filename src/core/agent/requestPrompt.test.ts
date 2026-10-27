import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@/types';
import type { PromptSection } from '@/core/llm/promptSections';
import { readFileTool } from '@/core/tools/definitions/fileTools';
import { composeRequestPromptSections } from './requestPrompt';

describe('composeRequestPromptSections', () => {
  it('keeps connected and deferred tools in the cached prefix with the safety anchor last', () => {
    const base: PromptSection[] = [
      { name: 'identity', text: 'Assistant', cacheable: true },
      { name: 'today', text: 'Today', cacheable: false },
      { name: 'safety', text: 'Safety', cacheable: false, pinToEnd: true },
    ];
    const tool = (name: string): ToolDefinition => ({ ...readFileTool, name });
    const result = composeRequestPromptSections(base, [tool('read_file'), tool('files__search'), tool('files__read')], 'Deferred tools');
    expect(result.map((section) => section.name)).toEqual(['identity', 'mcp-capabilities', 'deferred-tools', 'today', 'safety']);
    expect(result[1].text).toContain('- files: search, read');
    expect(result[1].text).not.toContain('read_file');
    expect(result.at(-1)).toEqual(base[2]);
    expect(base).toHaveLength(3);
  });

  it('adds no empty capability sections', () => {
    const base: PromptSection[] = [{ name: 'identity', text: 'Assistant', cacheable: true }];
    expect(composeRequestPromptSections(base, [], '')).toEqual(base);
  });
});
