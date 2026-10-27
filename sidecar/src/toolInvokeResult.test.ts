import { describe, expect, it, vi } from 'vitest';
import { readFileThroughTool } from '@/core/context/compaction';
import { unwrapToolInvokeResult } from './toolInvokeResult';

describe('tool invocation result metadata', () => {
  it('restores text after the shell result crosses the JSON boundary', async () => {
    const read = readFileThroughTool(async (_input, context) => {
      const wire = JSON.parse(JSON.stringify({
        result: 'current file contents',
        metadata: { fileReadOutcome: { kind: 'text', startLine: 1, lineCount: 1, totalLines: 1, bodyStart: 0 } },
      }));
      const result = unwrapToolInvokeResult(wire, context);
      expect(context.allowPermissionPrompts).toBe(false);
      return result as string;
    }, { conversationId: 'conversation' });
    expect(await read('/workspace/file.txt')).toBe('current file contents');
  });

  it('rejects invalid read metadata before reporting a successful read', () => {
    const reportMetadata = vi.fn();
    expect(() => unwrapToolInvokeResult({ result: 'body', metadata: { fileReadOutcome: { kind: 'text' } } }, { reportMetadata }))
      .toThrow('Invalid tool.invoke file read outcome envelope');
    expect(reportMetadata).not.toHaveBeenCalled();
  });
});
